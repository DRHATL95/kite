# Clipping — Design Spec (v1)

- **Date:** 2026-06-16
- **Status:** Draft for review
- **Branch:** `claude/elegant-sinoussi-0a6727`
- **Related:** [xbox-remote-improvement-program], `tauri.conf.json` updater wiring, `fix/connectable-standby` (coordination — see §12)

## 1. Summary

Add an **opt-in retroactive "clip that" feature**. When enabled, the app keeps the
most recent N seconds of the live stream buffered in memory; a single **Clip** button
saves that moment to disk as a WebM file and shows a toast offering to reveal it in the
OS file manager. All behaviour is configured from a **new Settings panel**.

The feature is **off by default** and the master switch gates the entire capture
pipeline — so it is genuinely zero-cost for normal use and only ever encodes when the
user has opted in.

## 2. Motivation & vision fit

The north-star ([xbox-remote-improvement-program]) is an audio-first daily driver,
"occasionally **video shared to Discord**," optimised for **reliability, light weight,
and performance — not feature count**.

Clipping is the rare new feature that directly serves the documented "share to Discord"
use case. To stay on-mission it must be:

- **Reliable** — a saved clip is always a valid, playable file.
- **Lightweight** — off by default; a single encoder; no heavy dependencies; no
  always-on cost unless explicitly enabled.
- **Performant** — must never measurably degrade streaming smoothness (verified on real
  hardware before the feature is considered done).

These three properties are treated as acceptance criteria, not aspirations.

## 3. Goals / Non-goals

### Goals (v1)

1. Retroactive capture of the last N seconds of the stream (video + Xbox audio).
2. A Settings panel with: master on/off, clip length, quality/bitrate, audio source.
3. Auto-save to a fixed Clips folder + a "Clip saved · Reveal" toast.
4. Cross-platform save + reveal (Windows/macOS/Linux).
5. Zero cost when disabled; bounded cost when enabled; no streaming regression.

### Non-goals (v1) — deferred fast-follows

- **PC-device audio capture** (Voicemeeter AUX / Discord bus / mic mixing). v1 records
  only the Xbox stream's own audio. The settings model reserves the seam for this
  (§6, `clipAudioSource`) so it lands later as a purely additive change. See §13.
- **Resolution downscale (720p/480p).** A per-frame canvas/WebCodecs re-scale is a
  continuous CPU cost that conflicts with "lightweight." v1 records at source
  resolution; file size is controlled via bitrate instead. See §13.
- **MP4 output.** The webview's `MediaRecorder` reliably emits WebM, which Discord
  plays inline. MP4 would force a manual muxer — out of scope.
- **Controller-button trigger.** Per the north-star, no investment in controller input.
- **Clipping across a reconnect.** The buffer resets when the WebRTC session restarts.

## 4. Locked decisions

| Decision | Choice |
|---|---|
| Capture model | Retroactive rolling buffer ("clip that") |
| Save flow | Auto-save to fixed folder + toast with Reveal |
| Default state | **Disabled** (master switch off) |
| Configuration home | New Settings modal (opened by a gear button) |
| Clip length | User-adjustable (15 / 30 / 60 s) |
| Resolution | Source only in v1; quality via bitrate |
| Audio (v1) | Xbox stream audio only |
| Output format | WebM (VP8/Opus preferred, feature-detected) |
| Buffer encoder | Single continuous `MediaRecorder` (Approach A) |

## 5. Architecture & file layout

The feature is overwhelmingly **additive** and front-end-centric. New files dominate;
edits to existing files are deliberately minimised and steered away from files that
`fix/connectable-standby` edits heavily (§12).

```
ui/src/lib/settings/
  settingsStore.svelte.ts   NEW  rune store; clip prefs; persisted to localStorage
ui/src/lib/clip/
  ClipBuffer.ts             NEW  pure-TS: MediaRecorder + rolling retention + assemble()
  clipStore.svelte.ts       NEW  observes mediaStream + settings; saveClip(); toast state
ui/src/screens/
  Settings.svelte           NEW  modal panel (composed from lib/design/Panel.svelte)
ui/src/components/
  Toast.svelte              NEW  reusable Carbon+Green toast ("Clip saved · Reveal")
  StreamControls.svelte     EDIT + Clip button (shown only when enabled) + gear button
ui/src/
  App.svelte                EDIT settings modal host + toast host + clip-buffer wiring
                                 + global gear entry (non-stream screens)
ui/src/lib/ipc/
  commands.ts               EDIT typed wrappers: saveClip(), revealClip()

src/                        (Rust — minimal)
  main.rs                   EDIT register save_clip command + tauri-plugin-opener
  clip.rs                   NEW  save_clip command (writes bytes → clips dir → path)
Cargo.toml                  EDIT + tauri-plugin-opener
capabilities/default.json   EDIT + "opener:allow-reveal-item-in-dir"
package.json (ui)           EDIT + @tauri-apps/plugin-opener
```

## 6. Settings model

A single rune store (`settingsStore.svelte.ts`) owns clip preferences, persisted to
`localStorage` (same lightweight pattern the volume slider already uses —
`StreamControls.svelte:48`). No backend, no settings file.

| Key | Type | Default | Notes |
|---|---|---|---|
| `clipEnabled` | boolean | **false** | Master switch. When false, `ClipBuffer` never instantiates → no encode cost. |
| `clipLengthSec` | `15 \| 30 \| 60` | `30` | Target rolling window. |
| `clipQuality` | `"low" \| "med" \| "high"` | `"med"` | Maps to `videoBitsPerSecond` (e.g. 4 / 8 / 12 Mbps — tunable). Cheap to vary; no rescale. |
| `clipAudioSource` | string enum | `"xbox"` | v1 offers only `"xbox"`. Reserved values like `"device:<id>"` enable the future PC-capture fast-follow with no churn here. |

**Forward-compatibility note:** modelling `clipAudioSource` as an open string enum is the
single design seam that makes the deferred Voicemeeter work additive. v1 ships the seam,
not the feature.

## 7. Settings UI

- **Entry points:**
  - Stream screen: a **gear** button in `StreamControls` (alongside Focus / Fullscreen).
  - Non-stream screens: a quiet fixed-position **gear** in `App.svelte` (mirrors the
    existing version label — hidden during streaming so it never overlays video).
  - Deliberately **not** added to `ConsoleList.svelte` (collision avoidance, §12).
- **Surface:** a modal overlay rendered by `App.svelte`, gated by a local
  `settingsOpen` `$state`. The router stays state-derived and untouched (§ insight).
- **Content:** built from `lib/design/Panel.svelte`. A "Clipping" panel with the master
  toggle; the length / quality / audio-source controls render only when enabled
  (progressive disclosure keeps the panel quiet when the feature is off).
- **Style:** Carbon+Green tokens; green = enabled/active, neutral otherwise.

## 8. ClipBuffer (Approach A — single continuous recorder)

`ClipBuffer.ts` is a pure-TS class (no Svelte imports), mirroring the discipline of
`ConnectionManager`. It owns one `MediaRecorder` and the rolling retention.

### 8.1 Input stream

The recorder runs on a `MediaStream` composed of the **video track + the Xbox audio
track** taken from `connectionStore.mediaStream`. These are the same track objects that
feed the `<video>` element; recording them does not disturb playback.

### 8.2 Codec & bitrate

- Prefer `video/webm;codecs=vp8,opus` (broad support, lower CPU than VP9); fall back via
  `MediaRecorder.isTypeSupported()`.
- `videoBitsPerSecond` derived from `clipQuality`.

### 8.3 Rolling retention — the key technical risk

WebM written by `MediaRecorder` places the initialisation header only in the **first
chunk** after `start()`, and clusters are only independently decodable from a
**keyframe**. A naïve "drop old chunks" buffer therefore yields an unplayable or
corrupt-at-the-head file. This is the crux of the design.

**v1 mechanism:**

- `recorder.start(1000)` → `ondataavailable` ~every 1 s.
- Cache the **init segment** (first chunk of the current recorder generation).
- Maintain a deque of subsequent cluster chunks; evict chunks older than
  `clipLengthSec` plus a small headroom.
- **Rotate** the recorder periodically (`stop()` → `start()`) so timestamps and the
  retained header stay consistent and memory stays bounded
  (≤ ~`clipLengthSec` × headroom of encoded video).
- On **Clip**: assemble `[cached header] + [retained cluster chunks]` into one Blob,
  trimming the head to the nearest retained keyframe so the file is always valid and
  ends at "now."

**Accepted tradeoff (stated honestly):** the saved clip always ends at the clip moment
and is always a valid, playable file, but its *length* may vary by up to roughly one
keyframe interval around the target. For a "share the moment" clip this is invisible in
practice. WebRTC streams emit periodic keyframes, and the app can even force one
(`requestKeyframe()`), which the buffer may leverage to tighten alignment.

**Reliability escalation (contingency, not v1 default):** if real-hardware testing shows
gaps, head-corruption, or unacceptable length variance, escalate to **dual offset
recorders** (two encoders started N/2 apart; on clip, pick whichever has ≥ N s of
coverage ending at now). This guarantees exact length but ~doubles continuous encode
cost — hence it is the fallback, not the default, and is gated on evidence from the
performance verification in §11.

### 8.4 Lifecycle & reconnect

- `clipStore` observes `connectionStore.mediaStream` and `settingsStore.clipEnabled`
  via a `$effect` wired in `App.svelte`.
- A `ClipBuffer` is created only when **enabled AND streaming AND a stream exists**.
- On stream change (reconnect builds a fresh `MediaStream` —
  `ConnectionManager.ts:1190`) or disconnect (stream → null), the old buffer is torn
  down and a new one created if still applicable. The buffer **resets** across a
  reconnect — clipping spans a single continuous session only.
- On `clipEnabled` → false, the buffer is destroyed immediately (encode stops at once).

## 9. Save · Reveal · Toast flow

```
enabled && streaming → ClipBuffer records (1 s timeslice, periodic rotation)
  user clicks Clip (or shortcut)
    → clipStore.saveClip()
    → ClipBuffer.assembleClip() → WebM Blob
    → invoke save_clip(<ArrayBuffer body>, name) → absolute path
    → Toast "Clip saved · Reveal"
        Reveal → invoke revealClip(path) → OS file manager opens at the file
```

- **Filename:** generated front-end (`xbox-clip-YYYYMMDD-HHMMSS.webm`). The JS `Date`
  restriction applies only to Workflow scripts, not app code.
- **Toast:** rendered by a host in `App.svelte`, driven by `clipStore` state; auto-
  dismiss after a few seconds, with a Reveal action button. Carbon+Green; uses the
  accent for the success state.

## 10. Backend (Rust)

Kept intentionally minimal.

- **`save_clip` (`clip.rs`)** — a plain `#[tauri::command]` that:
  - receives the clip bytes as a **raw request body** (`tauri::ipc::Request` /
    `Vec<u8>`), not a JSON number-array, for efficient multi-MB transfer;
  - resolves the platform Videos directory via the Tauri path API
    (`app.path().video_dir()`), ensures a `Xbox Remote Clips/` subfolder, writes
    `<name>.webm`, and returns the absolute path.
  - As our **own** command it needs no capability entry (per the project's established
    Tauri-2 rule: only plugin/core APIs require capabilities).
- **Reveal** — add `tauri-plugin-opener`; front-end calls its `revealItemInDir(path)`.
  - Cargo: `tauri-plugin-opener`; `main.rs`: `.plugin(tauri_plugin_opener::init())`.
  - UI: `@tauri-apps/plugin-opener`.
  - Capability: add `"opener:allow-reveal-item-in-dir"` to `capabilities/default.json`.
- **Clips folder:** `<video_dir>/Xbox Remote Clips/` — `~/Videos` (Windows),
  `~/Movies` (macOS), `$XDG_VIDEOS_DIR` (Linux).

## 11. Performance guardrails & verification

Performance is an acceptance criterion. The plan must:

1. Keep the feature **off by default**; the master switch gates the whole pipeline.
2. Use a **single** encoder (Approach A) and a **bounded** buffer.
3. Cap bitrate via the quality setting; prefer the cheaper codec.
4. **Verify on real Xbox hardware** that, with clipping enabled at default settings,
   streaming smoothness (audio continuity, video frame pacing, HUD stats) is
   indistinguishable from clipping disabled. This check **gates "done."**
5. If the check fails, first reduce default bitrate/length; only then consider the
   dual-recorder escalation (§8.3) if length reliability is the blocker.

## 12. Coordination with `fix/connectable-standby`

`fix/connectable-standby` (local + `origin`) is an active branch: ~1731 added lines
across `ui/src`, concentrated in the **auth / console-list** flow (`ConsoleList.svelte`,
`Login.svelte`, `DeviceCode.svelte`, `main.ts`) with only a 2-line touch to
`Stream.svelte`. It is **not** a UI rewrite.

- **Overlap surface with clipping:** `main.ts` (both may register/import), possibly
  `App.svelte` and `Stream.svelte`. Clipping deliberately **avoids `ConsoleList.svelte`**
  entirely.
- **Recommendation:** clipping merges/rebases **after** `fix/connectable-standby` (it is
  further along and on `origin`). Overlap is small and mechanical; whichever lands second
  resolves a minor rebase. The two features are functionally independent.

## 13. Future / fast-follows (out of v1 scope)

1. **PC-device audio capture (Voicemeeter / Discord / mic).** Add a device picker
   (`enumerateDevices`), `getUserMedia({ audio: { deviceId }})`, and a WebAudio mix
   (`AudioContext` → sources → `MediaStreamDestination`) feeding the recorder. Surfaces
   as additional `clipAudioSource` values (`device:<id>`) — additive, no v1 rework.
   Carries a mic-permission prompt (WebView2) and device-label-after-permission caveats.
2. **Resolution downscale (720p/480p)** via a canvas/WebCodecs rescale pass — only if a
   real need for smaller-than-bitrate-allows files emerges.
3. **Configurable keyboard shortcut** for Clip (v1 may ship a single non-conflicting
   default such as `Alt+C`, or button-only — decided in the plan).
4. **Dual-recorder exact-length mode** if §11 verification demands it.

## 14. Testing strategy

- **Unit (Vitest):** `settingsStore` persistence/defaults; `ClipBuffer` retention/
  eviction and `assembleClip()` validity using a mocked `MediaRecorder` emitting
  synthetic chunks (assert header presence + chunk ordering); filename generation.
- **Type-check:** `npm --prefix ui run check` clean.
- **Rust:** `save_clip` path resolution + folder creation (unit where practical).
- **Manual / hardware:** the §11 streaming-regression check; end-to-end clip → file →
  reveal → plays in a player and inline in Discord; reconnect resets the buffer; toggling
  disabled stops encoding.

## 15. Open questions

None blocking. Minor calls deferred to the implementation plan: exact rotation constants
(§8.3), bitrate values per quality tier (§6), and whether v1 ships the keyboard shortcut
(§13.3). All are tunable and do not affect the architecture.
