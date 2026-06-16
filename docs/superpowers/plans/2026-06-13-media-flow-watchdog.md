# Media-Flow Watchdog & Recovery Ladder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the app from showing "Streaming" over a dead stream by gating that state on real decoded video frames, with a keyframe-nudge → reconnect → honest-failure recovery ladder.

**Architecture:** A new timer-free `MediaMonitor` state machine (pure `tick(framesDecoded, now)` logic, unit-tested with an injected clock) is driven by a 1s interval in `ConnectionManager`. The dual-track gate now arms the monitor instead of jumping straight to `"streaming"`; the monitor fires callbacks for first-frame (→ streaming), nudge (→ keyframe request), and recover (→ existing reconnect). Exhausted recovery surfaces a reason-bearing banner on the console list.

**Tech Stack:** TypeScript, Svelte 5 runes, Vitest. Rust/Tauri backend is untouched.

**Spec:** [docs/superpowers/specs/2026-06-13-media-flow-watchdog-design.md](../specs/2026-06-13-media-flow-watchdog-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/src/lib/connection/mediaMonitor.ts` | **new** — pure watchdog state machine (no timers/DOM/getStats) |
| `ui/src/lib/connection/mediaMonitor.test.ts` | **new** — Vitest coverage of the state machine |
| `ui/src/lib/connection/constants.ts` | new "robustness — NOT from app.js" constants section |
| `ui/src/lib/connection/ConnectionManager.ts` | arm monitor from dual-track gate; drive `tick()`; wire callbacks; cleanup |
| `ui/src/lib/stores/connection.svelte.ts` | `failureReason` reactive field |
| `ui/src/screens/ConsoleList.svelte` | dismissible failure banner |

Build/run reminder (CLAUDE.md): after any `ui/src/` change, `npm --prefix ui run build` then `cargo clean -p xbox-remote && cargo run`. Unit tests run with `npm --prefix ui run test`.

---

## Task 1: Robustness constants

**Files:**
- Modify: `ui/src/lib/connection/constants.ts` (append a new section at end of file)

- [ ] **Step 1: Add the constants**

Append to the end of `ui/src/lib/connection/constants.ts`:

```ts
// ─────────────────────────────────────────────────────────────
// Media-flow watchdog (robustness — NOT from app.js)
// ─────────────────────────────────────────────────────────────
//
// These values are NOT part of the Xbox wire protocol and have no app.js
// provenance. They tune the media-flow watchdog that gates the "streaming"
// state on real decoded frames and drives keyframe-nudge / reconnect recovery.
// Safe to retune without touching the reference implementation.

/** How often ConnectionManager drives MediaMonitor.tick(). */
export const MEDIA_MONITOR_TICK_MS = 1_000;

/** Awaiting first frame: send keyframe nudge #1 this long after arming. */
export const MEDIA_START_NUDGE_1_MS = 4_000;

/** Awaiting first frame: send keyframe nudge #2 this long after arming. */
export const MEDIA_START_NUDGE_2_MS = 7_000;

/** Awaiting first frame: no decoded frame by here → trigger reconnect. */
export const MEDIA_START_TIMEOUT_MS = 10_000;

/** Streaming: frames stalled this long → send a keyframe nudge. */
export const MEDIA_STALL_NUDGE_MS = 4_000;

/** Streaming: frames stalled this long → trigger reconnect. */
export const MEDIA_STALL_TIMEOUT_MS = 8_000;
```

- [ ] **Step 2: Type-check**

Run: `npm --prefix ui run check`
Expected: PASS (no new errors; constants are unused so far — that is fine, they are exported).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/connection/constants.ts
git commit -m "feat(connection): add media-flow watchdog constants"
```

---

## Task 2: MediaMonitor — first-frame → streaming

**Files:**
- Create: `ui/src/lib/connection/mediaMonitor.ts`
- Test: `ui/src/lib/connection/mediaMonitor.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/connection/mediaMonitor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { MediaMonitor, type MediaMonitorCallbacks } from "./mediaMonitor.js";

function makeCallbacks(): MediaMonitorCallbacks & {
  starts: number;
  nudges: Array<"starting" | "stalled">;
  recovers: Array<"mediaNeverStarted" | "mediaStalled">;
} {
  const rec = {
    starts: 0,
    nudges: [] as Array<"starting" | "stalled">,
    recovers: [] as Array<"mediaNeverStarted" | "mediaStalled">,
    onMediaStart: () => { rec.starts++; },
    onNudge: (c: "starting" | "stalled") => { rec.nudges.push(c); },
    onRecover: (r: "mediaNeverStarted" | "mediaStalled") => { rec.recovers.push(r); },
  };
  return rec;
}

describe("MediaMonitor — first frame", () => {
  it("fires onMediaStart exactly once when frames start decoding", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 1_000);   // no frames yet
    expect(cb.starts).toBe(0);

    m.tick(3, 2_000);   // first decoded frames
    expect(cb.starts).toBe(1);

    m.tick(10, 3_000);  // still flowing — no second start
    expect(cb.starts).toBe(1);
    expect(cb.recovers).toEqual([]);
    expect(cb.nudges).toEqual([]);
  });

  it("is a no-op before arm()", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.tick(5, 1_000);
    expect(cb.starts).toBe(0);
    expect(cb.nudges).toEqual([]);
    expect(cb.recovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: FAIL — cannot find module `./mediaMonitor.js` / `MediaMonitor is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/lib/connection/mediaMonitor.ts`:

```ts
/**
 * mediaMonitor.ts — media-flow watchdog state machine.
 *
 * Pure decision logic: no timers, no DOM, no getStats. ConnectionManager owns a
 * setInterval and calls tick(framesDecoded, nowMs) once per MEDIA_MONITOR_TICK_MS,
 * passing the latest decoded-frame counter and Date.now(). The monitor decides
 * when media has started, when to nudge the encoder, and when to escalate to a
 * reconnect — firing callbacks for each. All thresholds are injectable so the
 * machine is deterministically unit-testable with a fake clock.
 *
 * See docs/superpowers/specs/2026-06-13-media-flow-watchdog-design.md
 */

import {
  MEDIA_START_NUDGE_1_MS,
  MEDIA_START_NUDGE_2_MS,
  MEDIA_START_TIMEOUT_MS,
  MEDIA_STALL_NUDGE_MS,
  MEDIA_STALL_TIMEOUT_MS,
} from "./constants.js";

export interface MediaMonitorCallbacks {
  /** First decoded frame seen — caller transitions to "streaming". */
  onMediaStart: () => void;
  /** Encoder kick — caller sends a keyframe request on the control channel. */
  onNudge: (context: "starting" | "stalled") => void;
  /** Recovery escalation — caller triggers a full reconnect with this reason. */
  onRecover: (reason: "mediaNeverStarted" | "mediaStalled") => void;
}

export interface MediaMonitorConfig {
  startNudge1Ms: number;
  startNudge2Ms: number;
  startTimeoutMs: number;
  stallNudgeMs: number;
  stallTimeoutMs: number;
}

const DEFAULT_CONFIG: MediaMonitorConfig = {
  startNudge1Ms: MEDIA_START_NUDGE_1_MS,
  startNudge2Ms: MEDIA_START_NUDGE_2_MS,
  startTimeoutMs: MEDIA_START_TIMEOUT_MS,
  stallNudgeMs: MEDIA_STALL_NUDGE_MS,
  stallTimeoutMs: MEDIA_STALL_TIMEOUT_MS,
};

type Phase = "idle" | "awaitingFirstFrame" | "flowing";

export class MediaMonitor {
  private readonly cb: MediaMonitorCallbacks;
  private readonly cfg: MediaMonitorConfig;

  private phase: Phase = "idle";
  private lastFrames: number | null = null;
  private armedAt = 0;
  private lastProgressAt = 0;
  private startNudgesSent = 0;
  private stallNudgeSent = false;

  constructor(cb: MediaMonitorCallbacks, cfg?: Partial<MediaMonitorConfig>) {
    this.cb = cb;
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** Arm in awaiting-first-frame phase (called from the dual-track gate). */
  arm(nowMs: number): void {
    this.phase = "awaitingFirstFrame";
    this.lastFrames = null;
    this.armedAt = nowMs;
    this.lastProgressAt = nowMs;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Stop & reset all internal state (called from _cleanupConnection). */
  reset(): void {
    this.phase = "idle";
    this.lastFrames = null;
    this.startNudgesSent = 0;
    this.stallNudgeSent = false;
  }

  /** Drive the state machine. Called once per ConnectionManager tick. */
  tick(framesDecoded: number | null, nowMs: number): void {
    if (this.phase === "awaitingFirstFrame") {
      if (framesDecoded != null && framesDecoded > 0) {
        this.phase = "flowing";
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.cb.onMediaStart();
      }
      return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: PASS (both tests in this file).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/connection/mediaMonitor.ts ui/src/lib/connection/mediaMonitor.test.ts
git commit -m "feat(connection): MediaMonitor first-frame -> streaming transition"
```

---

## Task 3: MediaMonitor — start nudges & never-started reconnect

**Files:**
- Modify: `ui/src/lib/connection/mediaMonitor.ts` (extend the `awaitingFirstFrame` branch)
- Test: `ui/src/lib/connection/mediaMonitor.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Append inside `mediaMonitor.test.ts` (new `describe` block at end of file):

```ts
describe("MediaMonitor — start escalation", () => {
  it("nudges at 4s and 7s, then reconnects at 10s when no frames arrive", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 1_000);
    m.tick(0, 3_000);
    expect(cb.nudges).toEqual([]);

    m.tick(0, 4_000);                       // nudge #1
    expect(cb.nudges).toEqual(["starting"]);

    m.tick(0, 5_000);                       // no extra nudge
    expect(cb.nudges).toEqual(["starting"]);

    m.tick(0, 7_000);                       // nudge #2
    expect(cb.nudges).toEqual(["starting", "starting"]);

    m.tick(0, 9_000);
    expect(cb.recovers).toEqual([]);

    m.tick(0, 10_000);                      // reconnect
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);

    m.tick(0, 11_000);                      // idle after recover — no repeats
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);
  });

  it("treats null framesDecoded as no-progress (same escalation)", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(null, 4_000);
    m.tick(null, 7_000);
    m.tick(null, 10_000);

    expect(cb.nudges).toEqual(["starting", "starting"]);
    expect(cb.recovers).toEqual(["mediaNeverStarted"]);
    expect(cb.starts).toBe(0);
  });

  it("starts streaming if frames arrive before the timeout (no recover)", () => {
    const cb = makeCallbacks();
    const m = new MediaMonitor(cb);
    m.arm(0);

    m.tick(0, 4_000);     // nudge #1
    m.tick(2, 5_000);     // frames! -> streaming
    m.tick(8, 11_000);    // well past 10s but flowing

    expect(cb.starts).toBe(1);
    expect(cb.recovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: FAIL — `nudges`/`recovers` stay empty (no escalation logic yet).

- [ ] **Step 3: Extend the implementation**

In `mediaMonitor.ts`, replace the `tick()` method body's `awaitingFirstFrame` branch (currently ending after the `if (framesDecoded ...) {...} return;`) with:

```ts
  tick(framesDecoded: number | null, nowMs: number): void {
    if (this.phase === "awaitingFirstFrame") {
      if (framesDecoded != null && framesDecoded > 0) {
        this.phase = "flowing";
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.cb.onMediaStart();
        return;
      }

      const elapsed = nowMs - this.armedAt;
      if (elapsed >= this.cfg.startTimeoutMs) {
        this.phase = "idle";
        this.cb.onRecover("mediaNeverStarted");
        return;
      }
      if (this.startNudgesSent === 0 && elapsed >= this.cfg.startNudge1Ms) {
        this.startNudgesSent = 1;
        this.cb.onNudge("starting");
        return;
      }
      if (this.startNudgesSent === 1 && elapsed >= this.cfg.startNudge2Ms) {
        this.startNudgesSent = 2;
        this.cb.onNudge("starting");
      }
      return;
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: PASS (Task 2 + Task 3 cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/connection/mediaMonitor.ts ui/src/lib/connection/mediaMonitor.test.ts
git commit -m "feat(connection): MediaMonitor start nudges + never-started reconnect"
```

---

## Task 4: MediaMonitor — mid-stream stall nudge & reconnect

**Files:**
- Modify: `ui/src/lib/connection/mediaMonitor.ts` (add the `flowing` branch)
- Test: `ui/src/lib/connection/mediaMonitor.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `mediaMonitor.test.ts`:

```ts
describe("MediaMonitor — mid-stream stall", () => {
  function armedAndFlowing(cb: ReturnType<typeof makeCallbacks>) {
    const m = new MediaMonitor(cb);
    m.arm(0);
    m.tick(1, 1_000);   // first frame -> flowing, lastProgressAt = 1000
    return m;
  }

  it("nudges at 4s stalled, reconnects at 8s stalled", () => {
    const cb = makeCallbacks();
    const m = armedAndFlowing(cb);

    m.tick(1, 3_000);   // no advance (still 1), stalled 2s
    expect(cb.nudges).toEqual([]);

    m.tick(1, 5_000);   // stalled 4s -> nudge
    expect(cb.nudges).toEqual(["stalled"]);

    m.tick(1, 6_000);   // stalled 5s -> no extra nudge
    expect(cb.nudges).toEqual(["stalled"]);

    m.tick(1, 9_000);   // stalled 8s -> reconnect
    expect(cb.recovers).toEqual(["mediaStalled"]);

    m.tick(1, 10_000);  // idle after recover
    expect(cb.recovers).toEqual(["mediaStalled"]);
  });

  it("recovers without reconnect when frames resume after a nudge", () => {
    const cb = makeCallbacks();
    const m = armedAndFlowing(cb);

    m.tick(1, 5_000);   // stalled 4s -> nudge
    expect(cb.nudges).toEqual(["stalled"]);

    m.tick(2, 6_000);   // frames advance -> progress clock resets, nudge guard clears
    m.tick(2, 9_000);   // stalled only 3s -> no nudge, no reconnect
    m.tick(3, 10_000);  // advance again

    expect(cb.recovers).toEqual([]);
    expect(cb.nudges).toEqual(["stalled"]); // the one earlier nudge only

    m.tick(3, 14_000);  // now stalled 4s again -> a fresh nudge is allowed
    expect(cb.nudges).toEqual(["stalled", "stalled"]);
  });

  it("does not start streaming or escalate after reset()", () => {
    const cb = makeCallbacks();
    const m = armedAndFlowing(cb);
    m.reset();
    m.tick(1, 20_000);
    m.tick(null, 30_000);
    expect(cb.recovers).toEqual([]);
    expect(cb.nudges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: FAIL — the `flowing` branch does nothing yet, so stall nudges/reconnects never fire.

- [ ] **Step 3: Add the `flowing` branch**

In `mediaMonitor.ts`, add this block to `tick()` immediately after the
`awaitingFirstFrame` branch's closing `}` (before the method's final `}`):

```ts
    if (this.phase === "flowing") {
      if (framesDecoded != null && this.lastFrames != null && framesDecoded > this.lastFrames) {
        this.lastFrames = framesDecoded;
        this.lastProgressAt = nowMs;
        this.stallNudgeSent = false;
        return;
      }
      if (framesDecoded != null) {
        this.lastFrames = framesDecoded;
      }

      const stalled = nowMs - this.lastProgressAt;
      if (stalled >= this.cfg.stallTimeoutMs) {
        this.phase = "idle";
        this.cb.onRecover("mediaStalled");
        return;
      }
      if (!this.stallNudgeSent && stalled >= this.cfg.stallNudgeMs) {
        this.stallNudgeSent = true;
        this.cb.onNudge("stalled");
      }
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix ui run test -- mediaMonitor`
Expected: PASS (all MediaMonitor cases).

- [ ] **Step 5: Run the full UI test suite (no regressions)**

Run: `npm --prefix ui run test`
Expected: PASS — existing `stats.test.ts`, `input.test.ts`, `DiagnosticsHud.test.ts` unaffected.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/connection/mediaMonitor.ts ui/src/lib/connection/mediaMonitor.test.ts
git commit -m "feat(connection): MediaMonitor mid-stream stall nudge + reconnect"
```

---

## Task 5: Wire MediaMonitor into ConnectionManager

**Files:**
- Modify: `ui/src/lib/connection/ConnectionManager.ts`
  - imports (top, around `:24-47`)
  - new field next to other private fields (around `:168-176`)
  - construct monitor in constructor (`:179-181`)
  - dual-track gate (`:581-592`)
  - stats sampler start (`:908-920`) — add the tick timer
  - cleanup (`:1162-1195`)

**Note:** `_setupTrackHandler` (`pc.ontrack`) and the gate run during
`setRemoteDescription`, before the sampler starts. The monitor tick timer reads
`this._lastSnapshot?.framesDecoded`, which is `null` until the sampler produces
its first snapshot — the monitor treats `null` as no-progress, so start-timeout
behaviour is correct even during that window.

- [ ] **Step 1: Add imports**

In `ConnectionManager.ts`, add to the `./constants.js` import block:

```ts
  MEDIA_MONITOR_TICK_MS,
```

And add a new import after the `GamepadPoller` import (around `:42`):

```ts
import { MediaMonitor } from "./mediaMonitor.js";
```

- [ ] **Step 2: Add the field and tick-timer field**

Next to `_sampler` (around `:168-169`) add:

```ts
  // ── Media-flow watchdog ────────────────────────────────────────────────────
  private _mediaMonitor: MediaMonitor | null = null;
  private _mediaMonitorTimer: ReturnType<typeof setInterval> | null = null;
```

- [ ] **Step 3: Construct the monitor in the constructor**

Replace the constructor body (`:179-181`) with:

```ts
  constructor(callbacks: ConnectionManagerCallbacks) {
    this._cb = callbacks;
    this._mediaMonitor = new MediaMonitor({
      onMediaStart: () => {
        if (this._state === "connecting" || this._state === "reconnecting") {
          this._log("First decoded frame — transitioning to streaming");
          this._setState("streaming");
          this._startGamepadPoller();
        }
      },
      onNudge: (context) => {
        if (this._channels && this._channels.control.readyState === "open") {
          sendKeyframeRequest(this._channels.control);
          this._keyframeRequestsSent++;
          this._log(`Media ${context} — sent keyframe nudge`);
          this._pushManagerStats();
        }
      },
      onRecover: (reason) => {
        this._log(`Media watchdog: ${reason} — escalating to reconnect`);
        this._triggerReconnect(reason);
      },
    });
  }
```

- [ ] **Step 4: Change the dual-track gate to arm the monitor**

Replace the dual-track gate block (`:581-592`) with:

```ts
      // Dual-track gate — spec §3.10; app.js:627-666
      // Both tracks negotiated. NOTE: ontrack fires during setRemoteDescription,
      // BEFORE media actually flows. Do NOT go to "streaming" here — arm the
      // media watchdog and let it promote us once frames actually decode.
      if (
        this._tracksReceived.video &&
        this._tracksReceived.audio &&
        !this._hasStartedPlaying
      ) {
        this._hasStartedPlaying = true;
        this._log("Both tracks negotiated — arming media watchdog (awaiting first frame)");
        this._mediaMonitor?.arm(Date.now());
      }
```

- [ ] **Step 5: Start the monitor tick timer alongside the stats sampler**

Replace `_startStatsSampler()` (`:908-920`) with:

```ts
  private _startStatsSampler(): void {
    if (!this._pc) return;
    this._sampler = new StatsSampler(
      this._pc,
      (snap: DiagnosticsSnapshot) => {
        this._lastSnapshot = snap;
        this._cb.onDiagnostics(snap);
      },
      2000,
    );
    this._pushManagerStats();
    this._sampler.start();

    // Drive the media watchdog off the latest snapshot's framesDecoded.
    if (this._mediaMonitorTimer === null) {
      this._mediaMonitorTimer = setInterval(() => {
        this._mediaMonitor?.tick(
          this._lastSnapshot?.framesDecoded ?? null,
          Date.now(),
        );
      }, MEDIA_MONITOR_TICK_MS);
    }
  }
```

- [ ] **Step 6: Stop the timer + reset the monitor in cleanup**

In `_cleanupConnection()`, immediately after the `this._stopStatsSampler();` line
(around `:1165`), add:

```ts
    if (this._mediaMonitorTimer !== null) {
      clearInterval(this._mediaMonitorTimer);
      this._mediaMonitorTimer = null;
    }
    this._mediaMonitor?.reset();
```

- [ ] **Step 7: Type-check**

Run: `npm --prefix ui run check`
Expected: PASS — no type errors. (`onNudge`/`onRecover` param types are inferred
from `MediaMonitorCallbacks`.)

- [ ] **Step 8: Run the full UI test suite**

Run: `npm --prefix ui run test`
Expected: PASS — no regressions.

- [ ] **Step 9: Commit**

```bash
git add ui/src/lib/connection/ConnectionManager.ts
git commit -m "feat(connection): gate streaming on real frames via MediaMonitor"
```

---

## Task 6: Expose `failureReason` from the connection store

**Files:**
- Modify: `ui/src/lib/connection/ConnectionManager.ts` (expose last trigger reason)
- Modify: `ui/src/lib/stores/connection.svelte.ts` (`failureReason` field)

- [ ] **Step 1: Expose the last trigger reason on the manager**

In `ConnectionManager.ts`, add a public getter next to the `state` getter
(around `:188-190`):

```ts
  /** The reason for the most recent reconnect trigger / failure, or null. */
  get lastTriggerReason(): string | null {
    return this._lastTriggerReason;
  }
```

- [ ] **Step 2: Add the reactive field and populate it on state change**

In `ui/src/lib/stores/connection.svelte.ts`, add a field after `reconnectAttempt`
(around `:49`):

```ts
  /**
   * Human-readable reason for the last failure, or null. Set when state becomes
   * "failed", cleared on a fresh connect(). Drives the ConsoleList failure banner.
   */
  failureReason: string | null = $state(null);
```

Then replace the `onStateChange` callback (`:57-61`) with:

```ts
      onStateChange: (s: SessionState) => {
        this.state = s;
        // Reset the live counter whenever we leave reconnecting state.
        if (s !== "reconnecting") this.reconnectAttempt = 0;
        // Capture a user-facing failure reason when we give up.
        if (s === "failed") {
          this.failureReason = mapFailureReason(this._manager.lastTriggerReason);
        }
      },
```

- [ ] **Step 3: Add the reason-mapping helper and clear-on-connect**

In `connection.svelte.ts`, add this module-level function above the
`class ConnectionStore` declaration (around `:24`):

```ts
/**
 * Map an internal reconnect/trigger reason to a user-facing failure message.
 * Media reasons point the user at the real-world fix (restart the console).
 */
function mapFailureReason(reason: string | null): string {
  if (reason === "mediaNeverStarted" || reason === "mediaStalled") {
    return "Couldn't get video from the console. It may be unresponsive — try restarting the console.";
  }
  return "The connection failed. Please try again.";
}
```

Then, in `connect()` (around `:94-96`), clear the previous reason before connecting:

```ts
  async connect(xboxConsole: XHomeConsole): Promise<void> {
    this.failureReason = null;
    await this._manager.connect(xboxConsole);
  }
```

- [ ] **Step 4: Type-check**

Run: `npm --prefix ui run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/connection/ConnectionManager.ts ui/src/lib/stores/connection.svelte.ts
git commit -m "feat(connection): expose user-facing failureReason on the store"
```

---

## Task 7: Failure banner on ConsoleList

**Files:**
- Modify: `ui/src/screens/ConsoleList.svelte`

**Context:** After a failure, `App.svelte` auto-returns to the console list 3s
later via `disconnect()`. `disconnect()` does NOT clear `failureReason` (only
`connect()` does), so the reason survives the bounce-back and can be shown here.

- [ ] **Step 1: Read the current ConsoleList to find the markup insertion point**

Run: `sed -n '1,60p' ui/src/screens/ConsoleList.svelte`
Expected: shows the `<script>` imports (including `connectionStore` — add it if
absent) and the top of the template where the banner will go.

- [ ] **Step 2: Ensure the store is imported**

In the `<script>` block of `ConsoleList.svelte`, ensure this import is present
(add it if missing):

```ts
  import { connectionStore } from "$lib/stores/connection.svelte.js";
```

- [ ] **Step 3: Add the dismissible banner at the top of the template**

Immediately inside the root element of the template (before the console list
content), add:

```svelte
{#if connectionStore.failureReason}
  <div class="failure-banner" role="alert">
    <span class="failure-banner__text">{connectionStore.failureReason}</span>
    <button
      class="failure-banner__dismiss"
      onclick={() => (connectionStore.failureReason = null)}
      aria-label="Dismiss"
    >✕</button>
  </div>
{/if}
```

- [ ] **Step 4: Add banner styles**

Add to the `<style>` block of `ConsoleList.svelte`:

```css
  .failure-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: color-mix(in srgb, var(--bad) 14%, var(--surface));
    border: 1px solid var(--bad);
    border-radius: var(--radius-md);
    color: var(--text);
  }

  .failure-banner__text {
    flex: 1;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  .failure-banner__dismiss {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-sm);
    line-height: 1;
    cursor: pointer;
    padding: 2px var(--space-1);
    border-radius: var(--radius-sm);
  }

  .failure-banner__dismiss:hover {
    color: var(--text);
  }

  .failure-banner__dismiss:focus-visible {
    box-shadow: var(--focus-ring);
  }
```

- [ ] **Step 5: Type-check + full test suite**

Run: `npm --prefix ui run check && npm --prefix ui run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/screens/ConsoleList.svelte
git commit -m "feat(ui): show failure reason banner on console list"
```

---

## Task 8: Build verification & manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Production build of the frontend**

Run: `npm --prefix ui run build`
Expected: Vite build succeeds, writes `ui/dist`.

- [ ] **Step 2: Rebuild and run the app with fresh assets**

Run: `cargo clean -p xbox-remote; cargo run`
Expected: app compiles and launches the Tauri window.

- [ ] **Step 3: Manual smoke test (happy path)**

Sign in → pick a console → connect. Confirm:
- The status dot reads **"Connecting"** (amber) until video actually appears.
- It flips to **"Streaming"** (green) only once the picture is visible.
- Open the HUD (`` ` ``); VideoPanel `fps`/`framesDecoded` are advancing.

- [ ] **Step 4: Manual smoke test (degraded path, best-effort)**

If a no-media console state can be reproduced (or simulated by blocking inbound
video), confirm the ladder: dot stays "Connecting", keyframe-request count in the
HUD increases (nudges), then "Reconnecting", then — if still no media — "Failed",
followed by an auto-return to the console list showing the red failure banner with
the restart-the-console message. Note: a healthy console will simply start
streaming; this step is best-effort and not a release blocker if no-media cannot
be forced.

- [ ] **Step 5: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "chore: media-flow watchdog smoke-test fixes"
```

(Skip if nothing changed.)

---

## Self-Review Notes

- **Spec coverage:** §Detection signal → Task 5 step 5 (reads `_lastSnapshot.framesDecoded`); §Architecture/MediaMonitor → Tasks 2-4; §State-flow change → Task 5 step 4; §Recovery ladder → Tasks 3-4 (logic) + Task 5 step 3 (wiring); §New constants → Task 1; §Honest-failure UI → Tasks 6-7; §Testing → Tasks 2-4 (unit) + Task 8 (manual). All covered.
- **Type consistency:** callback names `onMediaStart` / `onNudge` / `onRecover`, reason literals `"mediaNeverStarted"` / `"mediaStalled"`, and nudge contexts `"starting"` / `"stalled"` are identical across mediaMonitor.ts, its tests, and the ConnectionManager wiring. `lastTriggerReason` getter matches the private `_lastTriggerReason` field already set by `_triggerReconnect`.
- **No placeholders:** every code step contains complete code and exact run commands.
