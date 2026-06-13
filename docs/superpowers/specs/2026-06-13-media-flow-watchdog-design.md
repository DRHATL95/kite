# Media-Flow Watchdog & Recovery Ladder — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)
**Branch:** `feature/ui-redesign-and-updates`

## Problem

The app can display **"Streaming"** while the screen is black and silent. This was
observed in the field and only cleared after **power-cycling the Xbox console**
(not the app), which means the failure is **server-side**: the console completed
the WebRTC handshake but its encoder never started emitting frames, and stayed
wedged.

### Root cause

`ConnectionManager` transitions to the `"streaming"` state inside `pc.ontrack`
([`ConnectionManager.ts:581-592`](../../../ui/src/lib/connection/ConnectionManager.ts)),
gated only on **both an audio and a video track existing** (the "dual-track gate").

`pc.ontrack` fires **synchronously during `setRemoteDescription()`** — i.e. the
moment the SDP answer is applied, *before* ICE connects and *before* a single RTP
packet arrives. A `MediaStreamTrack` is created in the `muted` state and only
emits `unmute` once media actually flows. So `"streaming"` currently means
*"tracks were negotiated"*, **not** *"media is flowing."* When the console
negotiates but never sends frames, the UI shows a green "Streaming" dot over a
dead stream with no recovery path.

The `track.onunmute` event is wired ([`ConnectionManager.ts:551`](../../../ui/src/lib/connection/ConnectionManager.ts))
but used only for logging — it never gates state.

### Scope note

This bug exists on `master` as well as this branch. The connection stack
(`ConnectionManager.ts`, `dataChannels.ts`, `input.ts`, `stats.ts`) is **byte-for-byte
identical** to `master`; this branch's only `Stream.svelte`/`App.svelte` edits are
cosmetic (`background` colour). The fix is therefore independent of the UI redesign.

## Goals

1. Never display `"streaming"` unless media is genuinely flowing.
2. Detect both **(a)** media that never starts and **(b)** media that stalls
   mid-stream (froze after working).
3. Recover automatically and silently, escalating from cheap to expensive:
   keyframe nudge → full reconnect → honest failure.
4. When recovery is exhausted, tell the user *why* and point at the real fix
   (restart the console) instead of silently bouncing back.

## Non-goals

- Verifying **audio** flow independently. We gate on **video** `framesDecoded`
  (the authoritative "can the user see the game?" signal). Audio-only-silent with
  good video is a separate, rarer concern and out of scope.
- Changing any load-bearing protocol constant, the keepalive logic, the SDP/ICE
  exchange, or the reconnect attempt count/backoff.

## Detection signal

`StatsSampler` already computes `framesDecoded` (and `inboundVideoKbps`) from the
inbound-rtp video report every 2s, and `ConnectionManager` already receives every
snapshot via its `onDiagnostics` callback and stores it in `_lastSnapshot`
([`ConnectionManager.ts:908-920`](../../../ui/src/lib/connection/ConnectionManager.ts)).
No new plumbing is required — the watchdog reads `framesDecoded` from the snapshot
the manager already holds.

`framesDecoded` advancing is a stronger signal than `track.onunmute` or the DOM
`video.onplaying` event (the element can be "playing" a single frozen frame).
Using a `getStats`-derived counter also keeps the watchdog free of any DOM
dependency, consistent with `ConnectionManager` having no DOM access.

## Architecture

### New unit: `ui/src/lib/connection/mediaMonitor.ts`

A standalone class following the established pattern of `StatsSampler` /
`GamepadPoller`: **pure decision logic — no timers, no DOM, no `getStats`.**

- `ConnectionManager` owns a single `setInterval(…, MEDIA_MONITOR_TICK_MS)` and
  calls `monitor.tick(framesDecoded, nowMs)` on each tick, passing
  `this._lastSnapshot?.framesDecoded ?? null` and `Date.now()`.
- The monitor decides what (if anything) should happen and fires callbacks. It
  never reads the clock itself, so every threshold is deterministically testable
  with an injected `nowMs`.

```ts
export interface MediaMonitorCallbacks {
  /** First decoded frame seen — caller transitions to "streaming". */
  onMediaStart: () => void;
  /** Encoder kick — caller sends a keyframe request on the control channel. */
  onNudge: (context: "starting" | "stalled") => void;
  /** Recovery escalation — caller triggers a full reconnect with this reason. */
  onRecover: (reason: "mediaNeverStarted" | "mediaStalled") => void;
}

export class MediaMonitor {
  constructor(cb: MediaMonitorCallbacks, cfg?: Partial<MediaMonitorConfig>);
  /** Arm in awaiting-first-frame phase (called from the dual-track gate). */
  arm(nowMs: number): void;
  /** Drive the state machine. Called once per ConnectionManager tick. */
  tick(framesDecoded: number | null, nowMs: number): void;
  /** Stop & reset all internal state (called from _cleanupConnection). */
  reset(): void;
}
```

### State machine inside `MediaMonitor`

Phases: `idle` → `awaitingFirstFrame` → `flowing` (→ back to `idle` on reset).

Internal fields: `phase`, `lastFrames`, `armedAt`, `lastProgressAt`,
`startNudgesSent`, `stallNudgeSent`.

**`awaitingFirstFrame`** (armed when both tracks negotiate; no frames yet):
- If `framesDecoded != null && framesDecoded > 0`:
  → `phase = flowing`, `lastProgressAt = now`, `onMediaStart()`.
- Else, with `elapsed = now - armedAt`:
  - `elapsed ≥ MEDIA_START_NUDGE_1_MS` and `startNudgesSent === 0`
    → `onNudge("starting")`, `startNudgesSent = 1`.
  - `elapsed ≥ MEDIA_START_NUDGE_2_MS` and `startNudgesSent === 1`
    → `onNudge("starting")`, `startNudgesSent = 2`.
  - `elapsed ≥ MEDIA_START_TIMEOUT_MS`
    → `onRecover("mediaNeverStarted")`, `phase = idle`.

**`flowing`** (= UI `"streaming"`):
- If frames advanced (`framesDecoded > lastFrames`):
  → `lastProgressAt = now`, `stallNudgeSent = false`.
- Else, with `stalled = now - lastProgressAt`:
  - `stalled ≥ MEDIA_STALL_NUDGE_MS` and `!stallNudgeSent`
    → `onNudge("stalled")`, `stallNudgeSent = true`.
  - `stalled ≥ MEDIA_STALL_TIMEOUT_MS`
    → `onRecover("mediaStalled")`, `phase = idle`.

`lastFrames` is updated whenever `framesDecoded != null`.

### Changes to `ConnectionManager`

1. **Dual-track gate** ([`:581-592`](../../../ui/src/lib/connection/ConnectionManager.ts)):
   remove the direct `_setState("streaming")` + `_startGamepadPoller()`. Instead set
   `_hasStartedPlaying = true` (keep the double-fire guard) and call
   `_mediaMonitor.arm(Date.now())`. Stay in `"connecting"`.
2. **New monitor tick timer**: started alongside the stats sampler; on each tick
   calls `_mediaMonitor.tick(this._lastSnapshot?.framesDecoded ?? null, Date.now())`.
   Stopped in `_cleanupConnection`.
3. **`onMediaStart`** → `_setState("streaming")` + `_startGamepadPoller()`
   (the work moved out of the gate).
4. **`onNudge`** → reuse the existing keyframe path
   (`sendKeyframeRequest(this._channels.control)` / increment
   `_keyframeRequestsSent`), guarded on control channel `readyState === "open"`.
5. **`onRecover(reason)`** → `_triggerReconnect(reason)` (existing machinery,
   unchanged 3 attempts / backoff).
6. **`_cleanupConnection`**: `_mediaMonitor.reset()` and clear the tick timer.

No change to keepalive logic. (The API keepalive already self-stops on the
`400 / SessionInUnexpectedState` response and when `_state === "streaming"`;
deferring the `"streaming"` transition by a couple seconds is harmless because
the error-based stop still applies.)

### New constants (`constants.ts`)

Added under a **new, clearly-marked section** — these are robustness features,
**NOT** ported from `app.js`, and must not be confused with load-bearing protocol
values:

| Constant | Value | Meaning |
|---|---|---|
| `MEDIA_MONITOR_TICK_MS` | `1000` | How often `ConnectionManager` drives `tick()` |
| `MEDIA_START_NUDGE_1_MS` | `4000` | First keyframe nudge after arming |
| `MEDIA_START_NUDGE_2_MS` | `7000` | Second keyframe nudge after arming |
| `MEDIA_START_TIMEOUT_MS` | `10000` | No first frame by here → reconnect |
| `MEDIA_STALL_NUDGE_MS` | `4000` | Frames stalled this long → nudge |
| `MEDIA_STALL_TIMEOUT_MS` | `8000` | Frames stalled this long → reconnect |

### Honest-failure UI

- `connectionStore` gains `failureReason: string | null`, set from the manager's
  `_lastTriggerReason` when entering `"failed"`, cleared on a fresh `connect()`.
- A small mapping turns the internal reason into a user message; media reasons
  (`mediaNeverStarted`, `mediaStalled`) map to:
  *"Couldn't get video from <console>. It may be unresponsive — try restarting the console."*
- `ConsoleList` renders this as a dismissible banner when present (the user lands
  there after the existing 3s auto-return in `App.svelte`, so the message persists
  somewhere actionable rather than vanishing with the stream screen).

## Data flow

```
pc.setRemoteDescription(answer)
  └─ ontrack (audio + video)  →  dual-track gate
       └─ _mediaMonitor.arm(now)            [state stays "connecting"]

every MEDIA_MONITOR_TICK_MS:
  _mediaMonitor.tick(_lastSnapshot.framesDecoded, now)
       ├─ frames advance  → onMediaStart → _setState("streaming") + gamepad poller
       ├─ no frames @4s/7s → onNudge("starting") → keyframe request
       ├─ no frames @10s   → onRecover("mediaNeverStarted") → _triggerReconnect
       ├─ (flowing) stall @4s → onNudge("stalled") → keyframe request
       └─ (flowing) stall @8s → onRecover("mediaStalled") → _triggerReconnect

reconnect exhausts 3 attempts → "failed"
  └─ connectionStore.failureReason set → ConsoleList banner
```

## Error handling & edge cases

- **`framesDecoded` null** (sampler not yet started, or no inbound video stat):
  treated as "no progress". The start timeout still fires → nudge → reconnect.
- **Keyframe nudge when control channel closed**: guarded; skipped silently
  (a closed control channel is itself a reconnect trigger via the existing
  `onControlChannelClosed` handler).
- **User disconnect mid-wait**: `_cleanupConnection` calls `_mediaMonitor.reset()`
  and clears the tick timer; no stray callbacks fire after teardown.
- **Reconnect while monitoring**: monitor is reset on cleanup and re-armed by the
  next attempt's dual-track gate.
- **Frames resume after a stall nudge**: `stallNudgeSent` resets on the next
  advance; no reconnect — the nudge worked.
- **Counter wraparound / decrease**: `framesDecoded` is monotonic per session; a
  decrease (only possible across a `getStats` reset) is treated as no-progress,
  which is safe (worst case: one spurious nudge).

## Testing

- **`ui/src/lib/connection/mediaMonitor.test.ts`** (new, vitest): drive `tick()`
  with synthetic `(framesDecoded, now)` sequences and assert callback firing:
  1. First frame → `onMediaStart`, no nudges/recover.
  2. No frames → `onNudge("starting")` at 4s and 7s, `onRecover("mediaNeverStarted")` at 10s.
  3. Frames arrive at 5s → `onMediaStart`, recover never fires.
  4. Flowing then stall → `onNudge("stalled")` at 4s, `onRecover("mediaStalled")` at 8s.
  5. Flowing, stall, then frames resume before timeout → no recover; nudge guard resets.
  6. `null` framesDecoded throughout → treated as no-progress (path 2 timing).
  7. `reset()` mid-wait → subsequent `tick()` is a no-op until re-armed.
- Existing `stats.test.ts` / `input.test.ts` unchanged.
- Manual verification per project workflow: `npm --prefix ui run build` then
  `cargo clean -p xbox-remote && cargo run`; confirm the dot stays "Connecting"
  until video renders, and that a forced no-media console state escalates through
  nudge → reconnect → failed-with-banner.

## Files touched

| File | Change |
|---|---|
| `ui/src/lib/connection/mediaMonitor.ts` | **new** — watchdog state machine |
| `ui/src/lib/connection/mediaMonitor.test.ts` | **new** — unit tests |
| `ui/src/lib/connection/constants.ts` | new robustness constants section |
| `ui/src/lib/connection/ConnectionManager.ts` | gate change, tick timer, callback wiring, cleanup |
| `ui/src/lib/stores/connection.svelte.ts` | `failureReason` field |
| `ui/src/screens/ConsoleList.svelte` | failure banner |

`StreamStatus.svelte` / `Stream.svelte` are **not** edited: they already render
`"Connecting"`/`"Streaming"` from `connectionStore.state`, so deferring the
`"streaming"` transition makes the dot behave correctly with no markup change.

> Reminder (CLAUDE.md): after any `ui/src/` change, run `npm --prefix ui run build`
> then `cargo clean -p xbox-remote && cargo run` — Tauri embeds `ui/dist` at
> compile time and nothing rebuilds the frontend automatically.
