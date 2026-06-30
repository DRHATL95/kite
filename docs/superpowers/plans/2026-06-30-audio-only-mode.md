# Audio-only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in audio-only mode that declines the video track at the SDP offer so Xbox sends no video — saving bandwidth, decode, and render.

**Architecture:** The browser `ConnectionManager` is the offerer; when audio-only is set, its video transceiver becomes `inactive` (vs `recvonly`). A persisted `settings.audioOnly` flag flows `settings → connectionStore.connect() → ConnectionBackend.connect(console, { audioOnly })`. The streaming transition promotes on audio-track arrival instead of first video frame, and the decoded-frame watchdog is simply not armed (so it can't reconnect-loop on absent video). The Stream screen shows a minimal "audio only" panel in place of `<video>`.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vite, Vitest (jsdom), WebRTC in WebView2.

## Global Constraints

- **Browser path only for 1.0.** `NativeConnection` accepts but ignores `audioOnly` (native engine audio-only is a 1.1 follow-up).
- **Default OFF.** Audio-only is opt-in.
- **Applies on next connect.** No mid-stream renegotiation; toggling mid-stream takes effect on the next connect.
- **Testing convention:** pure logic is unit-tested (Vitest); Svelte/WebRTC glue is verified by `check` + `build` + an owner hardware smoke-test.
- **Frontend rebuild:** after UI changes run `pnpm --pm-on-fail=ignore --dir ui run build` (and `cargo clean -p xbox-remote && cargo run` only when launching the app).
- Commands: single test `pnpm --pm-on-fail=ignore --dir ui exec vitest run <file>`; type-check `pnpm --pm-on-fail=ignore --dir ui run check`; build `pnpm --pm-on-fail=ignore --dir ui run build`.

## File Structure

| File | Responsibility |
|------|----------------|
| `ui/src/lib/connection/audioOnly.ts` (new) | Pure decisions: video transceiver direction; tracks-ready-to-stream gate |
| `ui/src/lib/connection/audioOnly.test.ts` (new) | Unit tests for the above |
| `ui/src/lib/stores/settings.svelte.ts` | `audioOnly` state + `setAudioOnly` + persistence |
| `ui/src/lib/stores/settings.test.ts` | audio-only round-trip tests |
| `ui/src/lib/connection/backend.ts` | `connect(console, opts?)` signature |
| `ui/src/lib/connection/ConnectionManager.ts` | store flag; `inactive` transceiver; audio-gated transition |
| `ui/src/lib/connection/NativeConnection.ts` | accept-and-ignore `opts` |
| `ui/src/lib/stores/connection.svelte.ts` | snapshot `audioOnly`, read settings, pass to `connect` |
| `ui/src/screens/Stream.svelte` | audio-only panel (no `<video>`) |
| `ui/src/components/SettingsModal.svelte` | STREAM section + audio-only toggle |
| `ui/src/App.svelte` | `!audioOnly` guard on clip-attach |

---

### Task 1: Pure audio-only decision helpers

**Files:**
- Create: `ui/src/lib/connection/audioOnly.ts`
- Test: `ui/src/lib/connection/audioOnly.test.ts`

**Interfaces:**
- Produces: `videoTransceiverDirection(audioOnly: boolean): "inactive" | "recvonly"`; `tracksReadyToStream(audioOnly: boolean, hasVideo: boolean, hasAudio: boolean): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/lib/connection/audioOnly.test.ts
import { describe, it, expect } from "vitest";
import { videoTransceiverDirection, tracksReadyToStream } from "./audioOnly.js";

describe("videoTransceiverDirection", () => {
  it("declines video (inactive) when audio-only", () => {
    expect(videoTransceiverDirection(true)).toBe("inactive");
  });
  it("receives video (recvonly) normally", () => {
    expect(videoTransceiverDirection(false)).toBe("recvonly");
  });
});

describe("tracksReadyToStream", () => {
  it("normal mode needs BOTH video and audio", () => {
    expect(tracksReadyToStream(false, true, true)).toBe(true);
    expect(tracksReadyToStream(false, false, true)).toBe(false);
    expect(tracksReadyToStream(false, true, false)).toBe(false);
  });
  it("audio-only needs only audio (video never arrives)", () => {
    expect(tracksReadyToStream(true, false, true)).toBe(true);
    expect(tracksReadyToStream(true, false, false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --pm-on-fail=ignore --dir ui exec vitest run src/lib/connection/audioOnly.test.ts`
Expected: FAIL — "Cannot find module './audioOnly.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/lib/connection/audioOnly.ts
/**
 * Pure decisions for audio-only mode. Kept separate from ConnectionManager so
 * the WebRTC negotiation/transition rules are unit-testable without a
 * RTCPeerConnection (matches the encodedTapLogic / authFlowLogic pattern).
 */

/** Video transceiver direction for the offer: declined when audio-only. */
export function videoTransceiverDirection(
  audioOnly: boolean,
): "inactive" | "recvonly" {
  return audioOnly ? "inactive" : "recvonly";
}

/**
 * Whether enough tracks have arrived to promote to "streaming". Normal mode
 * waits for BOTH tracks (then a decoded-frame watchdog promotes on first frame);
 * audio-only waits for audio only, since no video track is ever negotiated.
 */
export function tracksReadyToStream(
  audioOnly: boolean,
  hasVideo: boolean,
  hasAudio: boolean,
): boolean {
  return audioOnly ? hasAudio : hasVideo && hasAudio;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --pm-on-fail=ignore --dir ui exec vitest run src/lib/connection/audioOnly.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/connection/audioOnly.ts ui/src/lib/connection/audioOnly.test.ts
git commit -m "feat(audio-only): pure transceiver-direction + tracks-ready helpers (TDD)"
```

---

### Task 2: `audioOnly` setting + persistence

**Files:**
- Modify: `ui/src/lib/stores/settings.svelte.ts`
- Test: `ui/src/lib/stores/settings.test.ts`

**Interfaces:**
- Produces: `settings.audioOnly: boolean` (default `false`); `settings.setAudioOnly(v: boolean): void`; persistence key `xbox-remote:audio-only`.

- [ ] **Step 1: Write the failing test** (append to `settings.test.ts`)

```ts
const AUDIO_ONLY_KEY = "xbox-remote:audio-only";

describe("settings store — audioOnly", () => {
  it("defaults to false when nothing persisted", async () => {
    await seed();
    const { settings } = await import("./settings.svelte.js");
    expect(settings.audioOnly).toBe(false);
  });

  it("persists and reflects an audio-only change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setAudioOnly(true);
    expect(settings.audioOnly).toBe(true);
    expect(persist.persisted.getItem(AUDIO_ONLY_KEY)).toBe("true");
  });

  it("restores a persisted audio-only=true on load", async () => {
    await seed([[AUDIO_ONLY_KEY, "true"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.audioOnly).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --pm-on-fail=ignore --dir ui exec vitest run src/lib/stores/settings.test.ts`
Expected: FAIL — `settings.audioOnly` is undefined / `setAudioOnly` is not a function.

- [ ] **Step 3: Write minimal implementation** (in `settings.svelte.ts`)

Add the key + reader near the other keys (after `LOG_VERBOSE_KEY`):

```ts
const AUDIO_ONLY_KEY = "xbox-remote:audio-only";

function readAudioOnly(): boolean {
  try {
    return persisted.getItem(AUDIO_ONLY_KEY) === "true";
  } catch {
    return false;
  }
}
```

Add the state field inside `class SettingsStore` (next to `logVerbose`):

```ts
  /** Decline video on the next connect (audio-only mode), persisted. */
  audioOnly: boolean = $state(readAudioOnly());
```

Add the setter (next to `setLogVerbose`):

```ts
  /** Set audio-only mode and persist it. Applies on the next connect. */
  setAudioOnly(v: boolean): void {
    this.audioOnly = v;
    try {
      persisted.setItem(AUDIO_ONLY_KEY, String(v));
    } catch {
      // best-effort persistence
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --pm-on-fail=ignore --dir ui exec vitest run src/lib/stores/settings.test.ts`
Expected: PASS (existing channel tests + 3 new audio-only tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/stores/settings.svelte.ts ui/src/lib/stores/settings.test.ts
git commit -m "feat(audio-only): persisted audioOnly setting (TDD)"
```

---

### Task 3: Plumb `audioOnly` to the offer (decline video)

**Files:**
- Modify: `ui/src/lib/connection/backend.ts:22`
- Modify: `ui/src/lib/connection/ConnectionManager.ts` (connect ~257-279; transceiver line 540; add field)
- Modify: `ui/src/lib/connection/NativeConnection.ts:89` (signature only)
- Modify: `ui/src/lib/stores/connection.svelte.ts` (connect ~242-262; add `audioOnly` snapshot field)

**Interfaces:**
- Consumes: `videoTransceiverDirection` (Task 1); `settings.audioOnly` (Task 2).
- Produces: `ConnectionBackend.connect(console, opts?: { audioOnly?: boolean })`; `connectionStore.audioOnly: boolean` (snapshot of the active session's mode, for the UI).

- [ ] **Step 1: Widen the backend contract** (`backend.ts:22`)

```ts
  connect(xboxConsole: XHomeConsole, opts?: { audioOnly?: boolean }): Promise<void>;
```

- [ ] **Step 2: ConnectionManager — accept opts, store the flag, decline video**

Add the field near `_gamepadPoller` (top of the class fields):

```ts
  /** Active session's audio-only mode; set in connect(), reused across reconnects. */
  private _audioOnly = false;
```

Add the import at the top with the other `./` imports:

```ts
import { videoTransceiverDirection, tracksReadyToStream } from "./audioOnly.js";
```

Change the `connect` signature (line ~257) and record the flag (just after `this._consoleType = ...`, ~line 279):

```ts
  async connect(xboxConsole: XHomeConsole, opts?: { audioOnly?: boolean }): Promise<void> {
```
```ts
    this._audioOnly = !!opts?.audioOnly;
```

Change the video transceiver (line 540) to use the helper:

```ts
    this._pc.addTransceiver("video", {
      direction: videoTransceiverDirection(this._audioOnly),
    });
```

- [ ] **Step 3: NativeConnection — accept and ignore opts** (`NativeConnection.ts:89`)

```ts
  async connect(xboxConsole: XHomeConsole, _opts?: { audioOnly?: boolean }): Promise<void> {
```
(No body change — native audio-only is a 1.1 follow-up.)

- [ ] **Step 4: connectionStore — snapshot the setting and pass it**

Ensure the settings import exists at the top of `connection.svelte.ts` (add if missing):

```ts
import { settings } from "./settings.svelte.js";
```

Add the snapshot field near the other `$state` fields (e.g. by `currentConsole`):

```ts
  /** Whether the active/last session was started in audio-only mode (snapshot at connect). */
  audioOnly: boolean = $state(false);
```

In `connect()` (line ~250), snapshot before connecting and pass it through:

```ts
    this.audioOnly = settings.audioOnly;
    this.state = "connecting";
    try {
      await this._impl.connect(xboxConsole, { audioOnly: this.audioOnly });
```

- [ ] **Step 5: Verify type-check + build**

Run: `pnpm --pm-on-fail=ignore --dir ui run check`
Expected: 0 errors.
Run: `pnpm --pm-on-fail=ignore --dir ui run build`
Expected: built ✓.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/connection/backend.ts ui/src/lib/connection/ConnectionManager.ts ui/src/lib/connection/NativeConnection.ts ui/src/lib/stores/connection.svelte.ts
git commit -m "feat(audio-only): decline video in the offer; thread audioOnly through connect()"
```

---

### Task 4: Audio-only streaming transition (don't hang / loop)

**Files:**
- Modify: `ui/src/lib/connection/ConnectionManager.ts` (the dual-track gate, ~646-654)

**Interfaces:**
- Consumes: `tracksReadyToStream` (Task 1); `this._audioOnly` (Task 3).

**Why:** Today the gate waits for BOTH tracks then arms the decoded-frame watchdog, which promotes to "streaming" on first video frame. In audio-only there is no video track or video frame, so (a) the gate would never fire, and (b) if armed, the watchdog would time out and reconnect-loop forever. Fix: promote on audio-track arrival and do NOT arm the watchdog.

- [ ] **Step 1: Replace the dual-track gate** (`ConnectionManager.ts:646-654`)

Replace:

```ts
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

with:

```ts
      if (
        tracksReadyToStream(
          this._audioOnly,
          this._tracksReceived.video,
          this._tracksReceived.audio,
        ) &&
        !this._hasStartedPlaying
      ) {
        this._hasStartedPlaying = true;
        if (this._audioOnly) {
          // No video track/frame will ever arrive — promote on audio-track
          // arrival and do NOT arm the decoded-frame watchdog (it would time out
          // and reconnect-loop forever). Hard drops are still caught by the
          // ICE/connection-state handlers.
          this._log("Audio-only: audio track negotiated — transitioning to streaming");
          if (this._state === "connecting" || this._state === "reconnecting") {
            this._setState("streaming");
            this._startGamepadPoller();
          }
        } else {
          this._log("Both tracks negotiated — arming media watchdog (awaiting first frame)");
          this._mediaMonitor?.arm(Date.now());
        }
      }
```

- [ ] **Step 2: Verify type-check + build**

Run: `pnpm --pm-on-fail=ignore --dir ui run check`
Expected: 0 errors.
Run: `pnpm --pm-on-fail=ignore --dir ui run build`
Expected: built ✓.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/connection/ConnectionManager.ts
git commit -m "feat(audio-only): promote to streaming on audio track; skip the frame watchdog"
```

---

### Task 5: Stream screen — minimal audio-only panel

**Files:**
- Modify: `ui/src/screens/Stream.svelte`

**Interfaces:**
- Consumes: `connectionStore.audioOnly` (Task 3).

**Approach:** audio-only behaves like `nativeMode` for the *video surface* (no `<video>`, splash dismissed on `state === "streaming"`), but additionally renders an "audio only" panel. Read `Stream.svelte`'s header comment + `nativeMode` usages in context; wherever `nativeMode` gates the `<video>` element, `srcObject`, autoplay/`videoPlaying`, and splash dismissal, broaden the condition to also cover audio-only.

- [ ] **Step 1: Add an `audioOnly` reactive** (near `const nativeMode = connectionStore.nativeMode;`, ~line 54)

```ts
  const audioOnly = $derived(connectionStore.audioOnly);
  // Both native mode and audio-only have no browser <video> surface to drive.
  const noVideoSurface = $derived(nativeMode || audioOnly);
```

- [ ] **Step 2: Gate the video surface on `noVideoSurface`**

In the `srcObject`/autoplay `$effect` and the markup, replace the `nativeMode` early-return / `{#if !nativeMode}` guards around the `<video>` element with `noVideoSurface` (so audio-only also skips `<video>` and drives splash dismissal from `connectionStore.state === "streaming"`, exactly as native already does). Keep all existing null guards.

- [ ] **Step 3: Render the audio-only panel** (inside the stream stage, shown when `audioOnly` and not `nativeMode`)

```svelte
{#if audioOnly}
  <div class="audio-only-stage">
    <span class="audio-only-badge">AUDIO ONLY</span>
    <p class="audio-only-name">{connectionStore.currentConsole?.deviceName ?? "Xbox"}</p>
    <div class="audio-only-indicator" role="status" aria-label="Audio connected">
      <span class="audio-only-dot"></span>
      <span>Connected · audio flowing</span>
    </div>
  </div>
{/if}
```

Add styles matching the design system (use `var(--surface)`, `var(--text-dim)`, `var(--accent)`; centered, calm). Model spacing/typography on the existing connecting-splash / status styles in the same file.

- [ ] **Step 4: Verify type-check + build**

Run: `pnpm --pm-on-fail=ignore --dir ui run check`
Expected: 0 errors.
Run: `pnpm --pm-on-fail=ignore --dir ui run build`
Expected: built ✓.

- [ ] **Step 5: Commit**

```bash
git add ui/src/screens/Stream.svelte
git commit -m "feat(audio-only): minimal audio-only panel on the Stream screen"
```

---

### Task 6: Settings toggle (STREAM section)

**Files:**
- Modify: `ui/src/components/SettingsModal.svelte`

**Interfaces:**
- Consumes: `settings.audioOnly`, `settings.setAudioOnly` (Task 2).

- [ ] **Step 1: Add a STREAM section** (model it on the existing CLIPPING section at `SettingsModal.svelte:177-228`; place it before CLIPPING)

```svelte
<!-- ── Stream ──────────────────────────────────────────────────────── -->
<section class="settings-section">
  <span class="settings-section__label">STREAM</span>
  <div class="settings-row">
    <div class="settings-row__text">
      <span class="settings-row__title">Audio-only mode</span>
      <span class="settings-row__hint">
        Stream sound + input, no video — saves bandwidth. Applies on next connect.
      </span>
    </div>
    <Toggle
      checked={settings.audioOnly}
      label="Audio-only mode"
      onchange={(on) => settings.setAudioOnly(on)}
    />
  </div>
</section>
```

(Match the exact row markup/classes used by the CLIPPING/DIAGNOSTICS rows in this file — copy their structure so styling is consistent.)

- [ ] **Step 2: Verify type-check + build**

Run: `pnpm --pm-on-fail=ignore --dir ui run check`
Expected: 0 errors.
Run: `pnpm --pm-on-fail=ignore --dir ui run build`
Expected: built ✓.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/SettingsModal.svelte
git commit -m "feat(audio-only): STREAM settings section with audio-only toggle"
```

---

### Task 7: Disable clipping in audio-only

**Files:**
- Modify: `ui/src/App.svelte` (the clip-attach `$effect`, ~lines 35-46)
- Modify: `ui/src/components/SettingsModal.svelte` (CLIPPING section — disable + note when audio-only)

**Interfaces:**
- Consumes: `connectionStore.audioOnly` (Task 3); `settings.audioOnly` (Task 2).

**Why:** clipping taps the video receiver; with no video track there is nothing to capture.

- [ ] **Step 1: Guard the clip-attach effect** (`App.svelte`)

In the clip `$effect`, add `!connectionStore.audioOnly` to the attach condition:

```ts
    if (c.enabled && streaming && stream && !connectionStore.audioOnly) {
      clipStore.attach(stream, { lengthSec: c.lengthSec, quality: c.quality });
    } else {
      clipStore.detach();
    }
```

- [ ] **Step 2: Reflect it in Settings** (`SettingsModal.svelte`, CLIPPING section)

Disable the clipping toggle and show a one-line note when `settings.audioOnly` is on:

```svelte
<Toggle
  checked={settings.clip.enabled}
  label="Enable clipping"
  disabled={settings.audioOnly}
  onchange={(on) => settings.setClip({ enabled: on })}
/>
{#if settings.audioOnly}
  <span class="settings-row__hint">Clipping needs video — unavailable in audio-only mode.</span>
{/if}
```

(Confirm `Toggle.svelte` accepts a `disabled` prop; if not, gate interaction in the section instead.)

- [ ] **Step 3: Verify type-check + build + full test suite**

Run: `pnpm --pm-on-fail=ignore --dir ui run check`
Expected: 0 errors.
Run: `pnpm --pm-on-fail=ignore --dir ui exec vitest run`
Expected: all pass (incl. Task 1 + Task 2 tests).
Run: `pnpm --pm-on-fail=ignore --dir ui run build`
Expected: built ✓.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.svelte ui/src/components/SettingsModal.svelte
git commit -m "feat(audio-only): disable clipping when audio-only (no video to tap)"
```

---

## Owner hardware smoke-test (after merge to a nightly)

1. Settings → STREAM → enable Audio-only. Connect with **no controller** attached.
2. Confirm: stream reaches "streaming" (no hang/reconnect loop), audio plays, input works, the Stream screen shows the audio panel (no video), and stats/HUD show no video track.
3. Toggle Audio-only off → next connect restores video.
4. Confirm the clipping toggle is disabled with the "needs video" note while audio-only is on.
