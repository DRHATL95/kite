# Native WebRTC Phase 6 — Tauri integration (Linux end-to-end) — Design (rev. 2)

> Status: DESIGN, rev. 2 (2026-06-21). Rev. 1 was pressure-tested by an adversarial
> 4-lens design-critique workflow (11 blockers, 17 important findings); this revision
> incorporates them and **re-sequences** the phase. Part of the native-webrtc effort
> (master plan `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md` §Phase 6).
> Phases 0–5 are merged to `master` (PR #15). Phase 7 (Windows/macOS unify) stays
> deferred until Phase 6 is **live-validated** on the Linux box.

## Goal

Drive the real Tauri app on **Linux** with the native Rust WebRTC engine: decoded
video renders in a native GTK surface under the existing transparent Svelte HUD;
input/stats/clip/keepalive work; the frontend uses the engine instead of the
browser `ConnectionManager`. End to end: sign-in → console list → connect → video +
audio + input + clip.

## Re-sequencing (decided 2026-06-21 after the design critique)

The render mount (re-parenting Tauri's *live* WebKitGTK webview under a `GLArea` +
window transparency) is an **unproven make-or-break that Phase 4 did NOT prove**
(Phase 4 used its own `tao` window + a fresh webview) and that **only the CachyOS
box can validate**. Everything else is portable. So Phase 6 splits into:

- **6a — Engine + Cargo prep (portable; build here, WSL-verified).** The engine API
  changes and dependency reshaping that the integration needs, all compile-checkable
  in WSL and useful regardless of how the render mount lands.
- **6b — Render-mount de-risk SPIKE (CachyOS; owner-run).** Prove the live-webview
  re-parent + transparency on the real Tauri window. Code is written here
  (compile-checked in WSL) but **validation + iteration happen on the box**. Full
  integration is gated on this spike.
- **6c — IPC + frontend (portable; build here, WSL + pnpm-verified).** The control
  plane and UI, which assume "video renders natively behind the HUD" independent of
  the exact mount mechanism.

## Decisions (locked)

1. **Engine selection: deterministic, not racy.** Native iff the `native-webrtc`
   feature is compiled AND `XBOX_FORCE_BROWSER_WEBRTC` is unset, exposed via
   `rtc_native_available()`. **The frontend MUST resolve this before the first
   `connect()` is possible** — App gates the ConsoleList "Connect" action on a
   "backend ready" flag (no defaulting-to-browser-on-a-native-build race). (Fixes
   critique: async-selection race.)
2. **Input: JS gathers, Rust encodes.** The `GamepadPoller` callback becomes a
   **tagged union** (`{kind:'metadata'} | {kind:'gamepad', state}`); the browser
   branch re-encodes via the existing pure `encode*` functions (byte-identical,
   tests preserved), the native branch ships `state` via `rtc_send_input`. **The
   engine itself sends the 15-byte client-metadata packet when the input channel
   opens** (single wire source; the native path does NOT forward a metadata packet —
   avoids double-send, since the engine also owns idle pulses). (Fixes: poller dual
   packets; client-metadata never sent natively; idle double-send.)
3. **`Disconnected` is terminal-only.** The engine emits `Reconnecting{attempt}` on a
   transient drop and reserves `Disconnected{reason}` for **terminal** teardown
   (give-up after the ladder / unrecoverable). User-initiated disconnect emits
   nothing (the frontend already knows). The frontend maps Reconnecting→`reconnecting`,
   Disconnected→`failed`, channel-closed(None)→`idle`. (Fixes: failure-flash on every
   reconnect.)
4. **GTK deps become feature-gated optional REAL deps.** `gtk`/`glow`/`libloading`/
   `tao`/`wry` move from `[dev-dependencies]` to
   `[target.'cfg(target_os = "linux")'.dependencies]` with `optional = true`, added to
   the `native-webrtc` feature, so `src/` can link them and the default Win/macOS
   build stays lean. **This supersedes PR #18** (which gated them as dev-deps); sequence
   so they don't conflict (rebase Phase 6 on master after #18, or close #18 in favor
   of this). (Fixes: src/ can't link dev-deps.)
5. **Scope: app integration; CI/AppImage deferred.** Live validation via
   `cargo run --features native-webrtc` on CachyOS. No CI/runner changes this phase.

## Architecture

Behind `native-webrtc` on Linux, the Tauri window's GTK tree is restructured so a
`gtk::GLArea` (native video) sits **under** Tauri's existing WebKitGTK webview
(transparent → the Svelte HUD shows over the video) inside a `gtk::Overlay`. The
engine decodes H.264→I420 and `put()`s frames into a `SharedFrame` held in
`AppState`; a 16 ms `glib` render tick on the GTK main thread uploads the latest
frame to the `GLArea` (YUV→RGB, BT.709). The frontend uses typed `rtc_*` IPC + a
one-way `rtc_event` Tauri event channel, behind a `NativeConnection` adapter that
implements the **same `ConnectionBackend` interface** the store consumes — so the
HUD, status, diagnostics, splash, and screen flow are path-agnostic.

## 6a — Engine + Cargo prep (portable)

**A1. Cargo deps reshape (`Cargo.toml`).** Move `gtk`/`glow`/`libloading`/`tao`/`wry`
to `[target.'cfg(target_os = "linux")'.dependencies]` `optional = true`; extend
`native-webrtc = [... "dep:gtk", "dep:glow", "dep:libloading"]` (tao/wry already come
via tauri, but the examples/renderer use these versions to unify). Give
`examples/render_spike` `required-features = ["native-webrtc"]` (it now needs the
feature-gated gtk). Verify `cargo build --features native-webrtc` (WSL) + `cargo build`
default (Win/macOS lean, no gtk). Supersedes PR #18.

**A2. `RtcHandle` splits the event receiver (`src/rtc/engine.rs`).** Add
`RtcHandle::take_events(&mut self) -> Option<mpsc::UnboundedReceiver<RtcEvent>>`
(returns the receiver once; `next_event` is removed/replaced). The Tauri forwarding
task owns the receiver; `AppState` holds only the cmd-sender + join side, so
`Mutex<Option<RtcHandle>>` never blocks on `.await`. Update `tests/rtc_e2e.rs` (Phase 5)
to `take_events()` + drain the receiver directly. (Fixes blocker: forwarding-task
deadlock.)

**A3. Client-metadata on input-channel-open (`src/rtc/engine.rs`).** When the `input`
channel opens, send `encode_client_metadata(seq, ts)` once (reusing the shared
`input_seq`). (Fixes blocker: metadata never sent natively.)

**A4. `EngineCommand::RequestKeyframe` + `RtcHandle::request_keyframe()`
(`src/rtc/engine.rs`).** New variant; the `cmd_rx` arm in `stream()` writes
`keyframe_request()` on Control via `apply_write`. (Fixes: keyframe command missing.)

**A5. Terminal-vs-transient `Disconnected` (`src/rtc/engine.rs`).** In `drive()`, a
transient drop that will retry emits **only** `Reconnecting{attempt}` (carry the
reason in a field/log), not `Disconnected`. Emit `Disconnected{reason}` only on
terminal give-up / unrecoverable bind failure, then return. (Fixes blocker: failure
flash.)

**A6. `play_path` threading (`src/rtc/engine.rs`, `signaling.rs`).** Add
`play_path: Option<String>` to `engine::spawn` → `signaling.create_session(server_id,
play_path)` (currently hardcodes `None`). (Fixes important: play_path dropped.)

**A7. Keepalive cadence note (no code unless live-validation fails).** The engine's
30 s API keepalive matches the browser; the steady session-keepalive relies on the
Phase-5 idle-pulse + input frames. **Live watch-item:** if a 60 s idle native session
drops (~56 s — CLAUDE.md pitfall #3), drive a steady data-channel keepalive from
`keepAlivePulseInSeconds` (already in `SessionInfo`). Not built blind; flagged for the
6b/end-to-end live run.

> 6a is fully WSL-compile-verifiable; pure helpers get default-build unit tests; the
> two engine behaviors that touch the wire (A3 client-metadata, A5 terminal semantics)
> are live-validated in the end-to-end run.

## 6b — Render-mount de-risk SPIKE (CachyOS, owner-run)

**B1. `GtkGlRenderer` (`src/rtc/media/render_gtk.rs`, gated).** Extract the inline GL
state + I420→RGB(BT.709) upload/draw from `examples/render_live.rs` into a unit:
`GtkGlRenderer::attach(area: &gtk::GLArea, frames: Arc<SharedFrame>)` — captures
`Rc<RefCell<Option<GlState>>>` for the realize/render closures (GTK-main-thread-only,
**not** Send/Sync), clones the `Arc<SharedFrame>` for `connect_render`
(`take_latest()` → upload → draw). `render_live.rs` is refactored to call it (parity
proof, kept as a Linux smoke test). Low-risk; transfers nearly verbatim.

**B2. tauri.conf.json transparency (config).** Add `"transparent": true` to
`app.windows[0]` (Linux needs it so tao installs the toplevel RGBA visual +
app-paintable; runtime `set_transparent` is not equivalent). Ensure the Svelte HUD
root background is transparent in native mode. (Fixes blocker.)

**B3. Live-webview re-parent mount (`src/lib.rs` setup, `cfg(all(target_os="linux",
feature="native-webrtc"))`).** The make-or-break. In Tauri `setup`, on the GTK main
thread: get the `WebviewWindow`; reach the wry webview `gtk::Widget` via
`with_webview(|w| WebviewExtUnix::webview())`; `container.remove()` it from the window
vbox (`WindowExtUnix::default_vbox()`); build `gtk::Overlay { GLArea base, the
re-parented webview on top }`; `vbox.pack_start(&overlay)`; `GtkGlRenderer::attach`;
start the 16 ms `glib::timeout_add_local` render tick; store `Arc<SharedFrame>` in
`AppState`. **Fallback if re-parenting a live X11-embedded webview fails:** build the
Overlay before the webview exists via a window-creation hook, or escalate to the
Moonlight separate-window model (Phase 7 territory). (Fixes blockers: re-parent
mechanic + transparency.)

**Spike acceptance (CachyOS):** `cargo run --features native-webrtc` → after connect,
the decoded video renders in the GLArea **under the transparent HUD**, HUD controls
remain visible/clickable, no flicker. This proves the compositing model the rest of
the integration assumes. The code for B1–B3 is written + WSL-compile-checked here;
**display correctness is owner-validated on the box** and may need iteration.

## 6c — IPC + frontend (portable)

**C1. `AppState` + `rtc_*` commands (`src/lib.rs`).** `AppState` gains
`frame_sink: Arc<SharedFrame>` (always — `SharedFrame`/`DecodedFrame` are codec-free,
default-build) and, **feature-gated**, `rtc: tokio::sync::Mutex<Option<RtcHandle>>`
(can't exist when `engine` is cfg'd out). Each `rtc_*` command is defined **once**
with `#[tauri::command]` and the cfg **inside the body** (real impl under the feature,
`Err("native unavailable")` otherwise) → one `generate_handler!` list, no duplicate
macro. Commands: `rtc_native_available()->bool`, `rtc_connect(server_id, play_path?)`,
`rtc_disconnect()`, `rtc_send_input(state)`, `rtc_request_keyframe()`,
`rtc_save_clip()->String`. (Fixes: conditional registration; AppState field gating.)

**C2. `rtc_connect` lifecycle (`src/lib.rs`).** Lock `state.auth`, **clone** it (XboxAuth
is Clone, shares the token store), drop the lock; refuse if `state.rtc` is `Some`;
`engine::spawn(auth, server_id, play_path, Some(state.frame_sink.clone()))`; store the
handle; `take_events()` and spawn a task forwarding `RtcEvent` → `app.emit("rtc_event",
RtcEventDto)`. **`rtc_connect` returns Ok as soon as the thread spawns; all connect
failures arrive async as `Disconnected`** — the frontend treats success as "attempting."
(Fixes important: auth plumbing + async-failure semantics.)

**C3. `RtcEventDto` + forwarding (`src/lib.rs`/`src/rtc`).** Serializable DTO mirroring
`RtcEvent` (Connecting/Connected/FirstFrame/Reconnecting{attempt}/Stats{...}/
Disconnected{reason}). The forwarding task ends when the receiver returns `None`
(engine thread exited) → emit a final "ended" so the frontend can go `idle`.

**C4. Window-close teardown (`src/lib.rs`).** `on_window_event` `CloseRequested` (and
app-exit): take the `RtcHandle` and `disconnect()` (joins the thread; tears down
socket/cpal/xHome session), stop the render tick. (Fixes blocker-adjacent: leaked
session orphans the console.)

**C5. `ConnectionBackend` interface (`ui/src/lib/connection/`).** Extract the FULL
surface `connection.svelte.ts` touches into one interface both `ConnectionManager` and
`NativeConnection` implement: `connect(console: XHomeConsole)`, `disconnect()`,
`requestKeyframe()`, `setEncodedTap(tap)`, `get encodedStreamsAvailable`,
`get lastSnapshot`, `get lastTriggerReason`, `get state`, + the callbacks ctor arg.
(Fixes blockers: adapter contract breadth; connect takes XHomeConsole.)

**C6. `NativeConnection` adapter (`ui/src/lib/connection/NativeConnection.ts`).**
Implements `ConnectionBackend`. `connect(console)` → `rtcConnect(console.serverId,
playPath)` + subscribe `rtc_event` (store the `UnlistenFn`; guard late events by a
session generation so a stale listener can't mutate a torn-down session). Event map:
Connecting→`onStateChange("connecting")`; **Connected→synthesize `handshakeMs`**;
**FirstFrame→synthesize `videoArrivedAt` + a `videoPlaying` surrogate + `onStateChange("streaming")`**;
Reconnecting→`onReconnectAttempt`+`"reconnecting"`; Stats→`onDiagnostics(completeSnapshot(...))`;
Disconnected→`onStateChange("failed")` (terminal only, per A5) + record `lastTriggerReason`;
ended(None)→`"idle"`. `setEncodedTap`=no-op, `encodedStreamsAvailable`=false.
`onMediaStream` is never invoked. Starts a `GamepadPoller` with the native tagged
callback (`metadata`→ignored, engine sends it; `gamepad`→`rtcSendInput(state)`).
(Fixes blockers: splash never clears, native input metadata, clip surface, contract.)

**C7. Deterministic store selection (`ui/src/lib/stores/connection.svelte.ts`,
`App.svelte`).** Resolve `rtc_native_available()` once at startup and **gate the
ConsoleList Connect action until resolved**; the store holds `_impl: ConnectionBackend`
chosen from that result. No connect can run before selection settles. (Fixes blocker:
selection race.)

**C8. Native clip path (`ui/src/lib/stores/clip.svelte.ts`, `StreamControls.svelte`,
`App.svelte`).** In native mode the clip pipeline (EncodedTap/MediaStream) is bypassed:
the "Clip" button → `connectionStore.saveClip()` → `rtcSaveClip()` (engine `ClipRing`
is always recording). The App.svelte clip-attach `$effect` is browser-only (gated on
`nativeMode`); `clip.enabled` gating must not depend on the browser tap. (Fixes blocker:
native clip unwired.)

**C9. `Stream.svelte` native branch (`Stream.svelte`).** When native: omit the `<video>`
element + the `srcObject`/autoplay/`needsUnmute`/`playTimer` machinery (inert, not just
hidden — keep `videoEl`-null guards); drive splash dismissal off the store state /
the FirstFrame `videoPlaying` surrogate (C6), not `<video>.onplaying`; the volume
control has no native target (audio is cpal) → **hide/disable the volume UI in native
mode** (no `rtc_set_volume` this phase, YAGNI). "Fix Video" → `requestKeyframe()`.
(Fixes blockers: splash; important: volume/unmute leak.)

**C10. Stats mapping + ipc wrappers (`ui/src/lib/`).** `NativeConnection` builds a
**complete** `DiagnosticsSnapshot` from a baseline (all required fields set:
`capturedAt`, `connectionState`, `source='unknown'`, `channels:[]`, `currentAttempt`,
`maxAttempts`, nullable RTCStats fields explicitly null) and overlays
`mapStats(StatsSnapshot)` (`bitrate_kbps→inboundVideoKbps`, `fps`, `frames_decoded`,
`freeze_count`) + lifecycle fields — never a `Partial`. New `ipc/commands.ts` wrappers
(`rtcNativeAvailable`, `rtcConnect`, `rtcDisconnect`, `rtcSendInput`,
`rtcRequestKeyframe`, `rtcSaveClip`) + `subscribeRtcEvents(cb)` via
`@tauri-apps/api/event` `listen` (core:default covers event listen/emit — no capability
change). (Fixes minor: Partial snapshot; capability confirm.)

## Data flow (native mode) — unchanged in shape from rev. 1; control via C2/C3/C6.

## Error handling
- Async connect failures → `Disconnected` (terminal) → store `"failed"` (existing banner via `mapFailureReason` + `lastTriggerReason`).
- Transient drops → `Reconnecting` only (no failure flash).
- Forwarding-task end (None) → "ended" → `"idle"`.
- Window close/app exit → C4 teardown (no orphaned console session).
- Non-Linux/non-feature → `rtc_native_available()` false → browser path; stub `rtc_*` never called.
- Late `rtc_event` after disconnect → dropped by the session-generation guard (C6).

## Testing / verification
- **Frontend (here, Windows):** `pnpm --dir ui run check` + `build`; Vitest unit tests for `NativeConnection` event→callback mapping (incl. terminal/transient + splash synthesis), `completeSnapshot`/`mapStats`, and the `GamepadPoller` tagged callback (browser branch byte-identical).
- **Rust (WSL):** `cargo build --features native-webrtc` (6a + 6b + 6c gated code) + default `cargo build` (lean); pure helpers default-build unit-tested; `tests/rtc_e2e.rs` updated for `take_events()` and still compiles under the feature.
- **Live (CachyOS, owner):** 6b spike (video composites under HUD); then end-to-end — sign-in → connect → video+audio+input+clip; reconnect on pull (no "failed" flash); 60 s idle survives (A7 watch-item); window-close tears down cleanly.

## Scope guardrails (YAGNI)
No user-facing engine toggle; no CI/runner/AppImage; no Windows/macOS native path (Phase 7); no `rtc_set_volume` (hide volume UI natively); no new RTCStats-equivalents; browser path untouched except the behavior-preserving `GamepadPoller` callback refactor and additive store selection.

## Risks
| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Re-parenting Tauri's live webview under a GtkOverlay fails (X11 embed / transparency / input) | **make-or-break** | 6b is an isolated spike on the box *before* full integration; fallback = build Overlay pre-webview, or Moonlight separate-window (Phase 7). |
| 2 | Native session drops ~56 s (keepalive cadence) | Medium | A7 live watch-item; drive steady keepalive from `keepAlivePulseInSeconds` if it fails. |
| 3 | 60 Hz `rtc_send_input` IPC overhead | Medium | small payload; measure; batch only if needed. |
| 4 | Keyboard focus over click-through HUD | Medium | `set_ignore_cursor_events` is pointer-only; validate live; gamepad primary. |
| 5 | Engine/Tauri lifecycle races (double-connect, late events) | Medium | single-owner `Mutex<Option<handle>>` + refuse-if-Some; session-generation guard on `rtc_event`. |
