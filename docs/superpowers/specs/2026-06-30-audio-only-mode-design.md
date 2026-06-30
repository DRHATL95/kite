# Audio-only mode — design

**Date:** 2026-06-30
**Status:** Approved (brainstorm) → ready for implementation plan
**Scope:** Windows-1.0, browser (WebView2) path only

## Overview

Add an opt-in **audio-only mode**: stream the console's audio + accept input, but
negotiate **no video track at all**, so Xbox stops sending video. This saves
bandwidth, decode, and render work — directly serving the "lean, audio-first
daily driver" north-star (e.g. listening to / controlling a game without watching
it).

This is *not* "hide the picture": the win is that the video bytes are never sent.

## Why this is clean

The browser path is the **offerer**: `ConnectionManager` builds the SDP offer with
explicit transceivers (`ConnectionManager.ts:539-540`):

```ts
this._pc.addTransceiver("audio", { direction: "sendrecv" });
this._pc.addTransceiver("video", { direction: "recvonly" });
```

So audio-only needs only that the **video transceiver be `inactive`** (rather than
omitted — keeping the m-line present but inactive is the least disruptive change to
the offer). Xbox then negotiates audio only; no video track arrives. One conditional
at the negotiation seam, no xHome protocol guesswork.

## Goals

- A persisted `audioOnly` setting (default **off**), toggled in Settings.
- When on, the next stream connects with video declined; the Stream screen shows a
  calm "audio-only" panel instead of a `<video>` surface.
- Input, audio playback, and mic/chat all work exactly as today.
- Reconnects within a session preserve the audio-only choice.

## Non-goals (explicitly out of scope for v1)

- **Mid-stream toggle.** Switching audio-only on/off mid-session would require an
  SDP renegotiation the xHome flow may not support. The setting applies on the
  **next connect**; changing it mid-stream shows a quiet "applies next connect" hint.
- **Native (Linux) path.** `NativeConnection` ignores `audioOnly` for 1.0; engine
  audio-only (skip video decode) is a 1.1 follow-up.
- **Audio-reactive visualisation.** The placeholder is a static minimal panel, not
  a VU meter / waveform (avoids the very CPU the mode is trying to save).

## Design

### 1. Setting (model + persistence)

Add to `settings.svelte.ts` (mirroring `logVerbose`):

- `audioOnly: boolean = $state(readAudioOnly())` — default `false`.
- `setAudioOnly(v: boolean)` — persists under key `xbox-remote:audio-only`.

Pure read/default logic stays trivial and is covered by a settings round-trip test
(matches the existing `settings.test.ts` pattern).

### 2. Config flow to the backend (no new coupling)

Thread the flag through the existing `ConnectionBackend` contract rather than
importing the settings store into `ConnectionManager`:

- `ConnectionBackend.connect(xboxConsole, opts?: { audioOnly?: boolean })`
  (`backend.ts`) — additive, optional.
- `connectionStore.connect(console)` reads `settings.audioOnly` and passes
  `{ audioOnly }` to `_impl.connect(...)`. The store is the right bridge layer.
- `ConnectionManager.connect(console, opts)` records `this._audioOnly = !!opts?.audioOnly`
  (so **reconnects reuse it**) and, at the transceiver seam, uses
  `direction: this._audioOnly ? "inactive" : "recvonly"` for video.
- `NativeConnection.connect(console, opts)` accepts but ignores `opts` for 1.0.

A tiny pure helper makes the decision testable without WebRTC:
`videoTransceiverDirection(audioOnly: boolean): "inactive" | "recvonly"`.

### 3. Streaming transition

Today the connecting splash clears / state → `streaming` keys off **video** arrival
(first decoded frame; `_videoArrivedAt`, the "both tracks" gate around
`ConnectionManager.ts:582,599,645`). In audio-only there is no video, so:

- When `_audioOnly`, the streaming transition gates on **audio-track arrival**
  instead of first video frame, and the media-flow watchdog's video-frame checks are
  skipped (audio-only has no decoded-frame counter to stall on).

This is the one non-trivial integration point and must be handled carefully so the
connecting splash always clears.

### 4. Stream UI (minimal audio panel)

In `Stream.svelte`, when the active session is audio-only:

- Do not mount the `<video>` element / srcObject path.
- Render a calm dark stage: console name, an "Audio only" badge, and a subtle
  "connected · audio flowing" indicator. Existing controls + diagnostics HUD stay.

The audio element / playback path is unchanged (audio still flows through the same
sink). Mic/chat unaffected — the audio transceiver remains `sendrecv`.

### 5. Clipping interaction

Clipping taps the **video** receiver (Insertable Streams), so it has nothing to
capture in audio-only. v1: **skip clip capture when audio-only** — the clip control
is disabled with a one-line "needs video" note, and `App.svelte`'s clip-attach effect
gains an `!audioOnly` guard so `EncodedTap` is never attached without a video track.

## Components touched

| File | Change |
|------|--------|
| `ui/src/lib/stores/settings.svelte.ts` | `audioOnly` state + `setAudioOnly` + persistence |
| `ui/src/lib/connection/backend.ts` | `connect(console, opts?)` signature |
| `ui/src/lib/stores/connection.svelte.ts` | read `settings.audioOnly`, pass to `connect` |
| `ui/src/lib/connection/ConnectionManager.ts` | store flag; `inactive` video transceiver; audio-gated streaming transition |
| `ui/src/lib/connection/NativeConnection.ts` | accept-and-ignore `opts` (1.0) |
| `ui/src/screens/Stream.svelte` | audio-only panel branch (no `<video>`) |
| `ui/src/components/SettingsModal.svelte` | "Stream" section with the audio-only toggle |
| `ui/src/App.svelte` | `!audioOnly` guard on clip-attach |
| (new) pure helper + tests | `videoTransceiverDirection`, settings round-trip |

## Testing

Following the codebase convention (pure logic unit-tested; Svelte/WebRTC glue via
type-check + build + owner smoke-test):

- **Unit (vitest):** settings round-trip (default off, persist/load); the pure
  `videoTransceiverDirection` mapping.
- **Type-check + build:** the threaded `connect(opts)` signature across backend +
  both impls + store; the `Stream.svelte` branch.
- **Owner hardware smoke-test (owed):** enable audio-only → connect → confirm audio +
  input work, the Stream screen shows the panel (no video), and stats/HUD show no
  video track. Toggle off → next connect restores video.

## Future (post-1.0)

- Native (Linux) engine audio-only (skip video decode) — 1.1.
- Mid-stream toggle via renegotiation, if the xHome flow proves to support it.
- Optional audio-reactive visualiser as a separate, off-by-default flourish.
