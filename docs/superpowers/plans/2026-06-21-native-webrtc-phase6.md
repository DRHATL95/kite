# Native WebRTC Phase 6 — Tauri integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the real Tauri app on Linux with the native Rust WebRTC engine — decoded video under the transparent Svelte HUD, input/stats/clip working, frontend on the engine instead of the browser `ConnectionManager` — end to end.

**Architecture:** Hexagonal as before. This plan delivers **6a** (engine + Cargo prep — portable, built + WSL-verified here), specifies **6b** (render-mount spike — code here, validated on CachyOS), and lists **6c** (IPC + frontend — portable) at interface+acceptance level for a follow-on detailed plan authored after 6a + the spike.

**Tech Stack:** Rust (str0m engine, tokio, gtk/glow/tao/wry feature-gated), Tauri 2.11, Svelte 5 + TS. Verification: WSL `cargo build --features native-webrtc`; `cargo test`/Vitest for pure parts; CachyOS for live.

**Spec:** `docs/superpowers/specs/2026-06-21-native-webrtc-phase6-design.md` (rev. 2; incorporates the 11-blocker design critique).

## Global Constraints

- **Edition 2024 / 1.85+.** Gated code behind the `native-webrtc` feature; the default Win/macOS build must stay lean (no gtk/glow/etc.).
- **Verification env:** gated Rust compiles in **WSL** (`wsl.exe bash -lc 'cd /mnt/c/Projects/xbox-remote/.claude/worktrees/flamboyant-volhard-019c62 && CARGO_TARGET_DIR=$HOME/wsl-target ~/.cargo/bin/cargo build --features native-webrtc'`); a clean build ends `Finished` with only the known pre-existing `xhome.rs` dead-code warnings. The frontend builds/tests on Windows (`pnpm --dir ui run check|build|test`). Live behavior is owner-validated on CachyOS.
- **Reuse, don't duplicate:** `engine::spawn`, `SharedFrame`, `rtc::input` encoder (incl. `encode_client_metadata`), `clip::{mux_opus_to_mp4, save_assembled_clip}`, `protocol::keyframe_request`, the frontend `connectionStore`/`GamepadPoller`/HUD.
- **`Disconnected` is terminal-only** (engine emits `Reconnecting` on transient drop). **GTK deps become feature-gated optional real deps** (supersedes PR #18). **Engine sends client-metadata** on input-channel-open. **Input wire-format has one source** (`rtc::input` in Rust for the native path).
- TDD where the code is pure/default-build; for gated wiring, the gate is the WSL feature build + `tests/rtc_e2e.rs` compiling (`--no-run`). Frequent commits; conventional `feat(rtc)`/`fix(rtc)` scope; end messages with the repo's Co-Authored-By trailer.

## File Structure (6a)

```
Cargo.toml                  MODIFY  — GTK deps → feature-gated optional [target.linux.dependencies]; render_spike required-features
src/rtc/engine.rs           MODIFY  — take_events(); client-metadata on input open; RequestKeyframe; terminal-only Disconnected; play_path
src/rtc/signaling.rs        MODIFY  — create_session takes play_path
tests/rtc_e2e.rs            MODIFY  — use take_events(); tolerate terminal-only Disconnected
```

---

## Task 6a.1: Feature-gate the GTK/render dependencies

**Files:** Modify `Cargo.toml`.

**Interfaces:** Produces a default build with NO gtk/glow/tao/wry/libloading, and a `--features native-webrtc` build that includes them on Linux. (Consumed by 6b's `render_gtk.rs` so `src/` can link gtk.)

- [ ] **Step 1: Move the five crates** from `[dev-dependencies]` to a new `[target.'cfg(target_os = "linux")'.dependencies]` table with `optional = true`:

```toml
[target.'cfg(target_os = "linux")'.dependencies]
# Native Linux render stack (Phase 4/6). Optional + feature-gated so the default
# Win/macOS build stays lean and `cargo test` doesn't pull gtk on Windows.
gtk = { version = "0.18", optional = true }
glow = { version = "0.13", optional = true }
libloading = { version = "0.7", optional = true }
tao = { version = "0.35", optional = true }
wry = { version = "0.55", optional = true }
```

Remove those five lines from `[dev-dependencies]` (keep `tempfile`, `insta`, `anyhow`, `image`).

- [ ] **Step 2: Add them to the feature** in `[features]`:

```toml
native-webrtc = ["dep:str0m", "dep:opus", "dep:ffmpeg-the-third", "dep:bytes", "dep:cpal", "dep:gtk", "dep:glow", "dep:libloading", "dep:tao", "dep:wry"]
```

- [ ] **Step 3: Gate `render_spike`** (it uses gtk and has no required-features) — add to its `[[example]]`:

```toml
[[example]]
name = "render_spike"
required-features = ["native-webrtc"]
```

- [ ] **Step 4: Verify default build is lean (Windows host).**

Run: `cargo tree -e features 2>/dev/null | grep -iE "gtk|gio-sys" || echo "no gtk in default build"`
Expected: `no gtk in default build`. Also `cargo build` (default) compiles. (Confirms the supersede of PR #18 holds: gtk absent on Windows default.)

- [ ] **Step 5: Verify the feature build (WSL).**

Run: `wsl.exe bash -lc 'cd /mnt/c/Projects/xbox-remote/.claude/worktrees/flamboyant-volhard-019c62 && CARGO_TARGET_DIR=$HOME/wsl-target ~/.cargo/bin/cargo build --features native-webrtc'`
Expected: `Finished` (gtk now a real dep, links from src/ later). Only the 8 known xhome.rs warnings.

- [ ] **Step 6: Commit.**

```bash
git add Cargo.toml
git commit -m "build(rtc): feature-gate GTK/render deps as optional linux deps (Phase 6 6a.1)"
```

> Note: `Cargo.lock` may move the five crates between sections; include it if changed (real change, not EOL churn).

---

## Task 6a.2: `RtcHandle` — split the event receiver out

**Files:** Modify `src/rtc/engine.rs`, `tests/rtc_e2e.rs`.

**Interfaces:**
- Consumes: existing `RtcHandle { cmd_tx, events, join }`, `RtcEvent`.
- Produces: `RtcHandle::take_events(&mut self) -> Option<tokio::sync::mpsc::UnboundedReceiver<RtcEvent>>`; `next_event` removed. (Consumed by 6c's forwarding task; lets `AppState` hold the cmd/join side in a `Mutex` without the receiver.)

- [ ] **Step 1: Change `RtcHandle`** to hold the receiver as `Option`:

```rust
pub struct RtcHandle {
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    events: Option<mpsc::UnboundedReceiver<RtcEvent>>,
    join: std::thread::JoinHandle<()>,
}
```

In `spawn(...)`, construct `events: Some(events)`.

- [ ] **Step 2: Replace `next_event` with `take_events`:**

```rust
/// Take sole ownership of the event stream (once). The caller (the Tauri
/// forwarding task / the E2E test) drains it independently of the command side,
/// so the handle can live behind a Mutex without holding it across .await.
pub fn take_events(&mut self) -> Option<mpsc::UnboundedReceiver<RtcEvent>> {
    self.events.take()
}
```

`send_input`, `request_keyframe` (6a.4), `clip`, `disconnect` are unchanged (they use `cmd_tx`/`join`).

- [ ] **Step 3: Update `tests/rtc_e2e.rs`** to drain via `take_events()`:

```rust
let mut handle = engine::spawn(auth, server_id, None, None).expect("spawn engine"); // play_path arg lands in 6a.6; for now keep the current arity if 6a.6 not yet applied
let mut rx = handle.take_events().expect("event stream");
// replace `handle.next_event().await` with `rx.recv().await`
```

> If 6a.6 (play_path) is not yet applied when this task runs, keep `spawn(auth, server_id, None)` and only change the event draining. The reviewer checks the test compiles under the feature.

- [ ] **Step 4: Verify (WSL).**

Run: `wsl.exe bash -lc 'cd /mnt/c/Projects/xbox-remote/.claude/worktrees/flamboyant-volhard-019c62 && CARGO_TARGET_DIR=$HOME/wsl-target ~/.cargo/bin/cargo build --features native-webrtc && CARGO_TARGET_DIR=$HOME/wsl-target ~/.cargo/bin/cargo test --features native-webrtc --test rtc_e2e --no-run'`
Expected: both `Finished`; no new warnings (an unused `events` field warning would mean `take_events` isn't wired).

- [ ] **Step 5: Commit.**

```bash
git add src/rtc/engine.rs tests/rtc_e2e.rs
git commit -m "refactor(rtc): RtcHandle::take_events splits the event stream from the handle (6a.2)"
```

---

## Task 6a.3: Engine sends the 15-byte client-metadata on input-channel-open

**Files:** Modify `src/rtc/engine.rs`.

**Interfaces:** Consumes `rtc::input::encode_client_metadata(seq, ts) -> [u8;15]`, the shared `input_seq`, the `now_ms` clock, `write_channel`/`ChannelLabel::Input`. Produces: the engine emits client-metadata once when the input channel opens (so native input initializes the channel exactly like the browser `GamepadPoller`'s first tick).

- [ ] **Step 1:** In the `Event::ChannelOpen` handling in `stream()` (where channels are mapped), when the opened channel is `ChannelLabel::Input`, send client metadata once:

```rust
// in the channel-open branch, after recording the Input channel id:
if label == ChannelLabel::Input && !client_metadata_sent {
    client_metadata_sent = true;
    let bytes = encode_client_metadata(input_seq, now_ms());
    input_seq = input_seq.wrapping_add(1);
    write_channel(&mut rtc, ids.get(ChannelLabel::Input), &bytes);
}
```

Add `let mut client_metadata_sent = false;` beside `input_seq` in `stream()`, and `use crate::rtc::input::encode_client_metadata;`.

> READ engine.rs to confirm where channel-open is observed (str0m `Event::ChannelOpen`/the channels map). If channel ids are resolved in a helper, place the metadata send where the Input id first becomes known. Reuse the existing `input_seq` (do NOT add a second counter).

- [ ] **Step 2: Verify (WSL).** `cargo build --features native-webrtc` → `Finished`, no new warnings.

- [ ] **Step 3: Commit.** `feat(rtc): send client-metadata when the input channel opens (6a.3)`

---

## Task 6a.4: `EngineCommand::RequestKeyframe` + `RtcHandle::request_keyframe`

**Files:** Modify `src/rtc/engine.rs`.

**Interfaces:** Produces `RtcHandle::request_keyframe(&self)` (sends `EngineCommand::RequestKeyframe`); the engine writes `protocol::keyframe_request()` on Control. (Consumed by 6c's `rtc_request_keyframe` command / `NativeConnection.requestKeyframe`.)

- [ ] **Step 1:** Add the variant + handle method + cmd arm:

```rust
pub enum EngineCommand {
    SendInput(GamepadFrame),
    Clip(oneshot::Sender<Option<AssembledClip>>),
    RequestKeyframe,            // NEW
    Disconnect,
}
```

```rust
// RtcHandle:
pub fn request_keyframe(&self) {
    let _ = self.cmd_tx.send(EngineCommand::RequestKeyframe);
}
```

In the `cmd` arm of `stream()`'s `select!` (beside `SendInput`/`Clip`/`Disconnect`):

```rust
EngineCommand::RequestKeyframe => {
    apply_write(&mut rtc, &ids, &ChannelWrite {
        label: ChannelLabel::Control,
        bytes: serde_json::to_vec(&keyframe_request()).expect("serialize"),
    });
}
```

Ensure any other exhaustive `match` on `EngineCommand` (e.g. the reconnect-backoff `matches!`) still compiles (the `matches!` macro is fine; an exhaustive `match` needs the new arm).

- [ ] **Step 2: Verify (WSL).** `cargo build --features native-webrtc` → `Finished`, no new warnings.

- [ ] **Step 3: Commit.** `feat(rtc): RequestKeyframe command + RtcHandle::request_keyframe (6a.4)`

---

## Task 6a.5: `Disconnected` is terminal-only

**Files:** Modify `src/rtc/engine.rs`, `tests/rtc_e2e.rs`.

**Interfaces:** Produces this event contract: a transient drop emits `RtcEvent::Reconnecting{attempt}` (no `Disconnected`); `RtcEvent::Disconnected{reason}` is emitted only on terminal give-up / unrecoverable; user-disconnect emits nothing. (Consumed by 6c's `NativeConnection` mapping: Reconnecting→reconnecting, Disconnected→failed.)

- [ ] **Step 1:** In `drive()`'s reconnect loop, restructure the `SessionEnd::Dropped(why)` arm so the **transient** path does NOT emit `Disconnected`:

```rust
SessionEnd::Dropped(why) => {
    match state.on_dropped() {
        Transition::ScheduleReconnect(d) => {
            tokio::select! {
                _ = tokio::time::sleep(d) => {}
                cmd = cmd_rx.recv() => {
                    if matches!(cmd, Some(EngineCommand::Disconnect) | None) { return Ok(()); }
                }
            }
            let _ = event_tx.send(RtcEvent::Reconnecting { attempt: state.attempt() });
            // NOTE: `why` is logged, not surfaced as Disconnected (transient).
            tracing::info!(reason = %why, attempt = state.attempt(), "transient drop — reconnecting");
        }
        Transition::GiveUp => {
            let _ = event_tx.send(RtcEvent::Disconnected(why)); // terminal
            return Ok(());
        }
    }
}
```

(Remove the previous unconditional `event_tx.send(RtcEvent::Disconnected(why))` that ran before `on_dropped`.)

- [ ] **Step 2: Update `tests/rtc_e2e.rs`** — the test currently `panic!`s on any `Disconnected`. Keep that (a terminal Disconnected during the E2E IS a failure), but it will no longer fire on transient drops. No code change needed unless the test asserted transient Disconnected (it doesn't). Confirm on read.

- [ ] **Step 3: Verify (WSL).** `cargo build --features native-webrtc && cargo test --features native-webrtc --test rtc_e2e --no-run` → both `Finished`.

- [ ] **Step 4: Commit.** `feat(rtc): Disconnected is terminal-only; transient drops emit Reconnecting (6a.5)`

---

## Task 6a.6: Thread `play_path` through spawn + signaling

**Files:** Modify `src/rtc/engine.rs`, `src/rtc/signaling.rs`, `tests/rtc_e2e.rs`.

**Interfaces:** Produces `engine::spawn(auth, server_id, play_path: Option<String>, frame_sink)`; `Signaling::create_session(&self, server_id, play_path: Option<&str>)`. (Consumed by 6c's `rtc_connect(server_id, play_path?)`.)

- [ ] **Step 1:** Add `play_path: Option<String>` to `engine::spawn` and thread it into `drive()` → `signaling.create_session(&server_id, play_path.as_deref())`. Update the `Signaling` trait + `XHomeSignaling` impl to pass it to `client.create_session(server_id, play_path)` (the xHome client already accepts an `Option`).

- [ ] **Step 2:** Update `tests/rtc_e2e.rs` call site: `engine::spawn(auth, server_id, None, None)`.

- [ ] **Step 3: Verify (WSL).** `cargo build --features native-webrtc && cargo test --features native-webrtc --test rtc_e2e --no-run` → `Finished`.

- [ ] **Step 4: Commit.** `feat(rtc): thread play_path through spawn + signaling.create_session (6a.6)`

---

## Task 6b (SPIKE): render-mount on the real Tauri window — code here, validate on CachyOS

> This is a **de-risk spike**, not a TDD task. The code below is written here and
> WSL-compile-checked; **display correctness is owner-validated on the CachyOS box**
> and may require iteration. Full 6c integration is gated on this proving out.

**Files:** Create `src/rtc/media/render_gtk.rs`; modify `src/rtc/media/mod.rs`, `examples/render_live.rs`, `src/lib.rs`, `tauri.conf.json`.

**Steps (build here):**
- [ ] **B1 — Extract `GtkGlRenderer`** from `examples/render_live.rs` into `src/rtc/media/render_gtk.rs` (gated): `pub fn attach(area: &gtk::GLArea, frames: std::sync::Arc<SharedFrame>)` capturing `Rc<RefCell<Option<GlState>>>` for the realize/render closures (GTK-thread-only; not Send/Sync). Refactor `render_live.rs` to call it. Verify `cargo build --features native-webrtc --examples` (WSL).
- [ ] **B2 — `tauri.conf.json`**: add `"transparent": true` to `app.windows[0]`; ensure the Svelte HUD root is transparent in native mode.
- [ ] **B3 — Mount in `src/lib.rs` setup** (`cfg(all(target_os="linux", feature="native-webrtc"))`): on the GTK main thread, reach the wry webview widget via `WebviewWindow::with_webview(|w| WebviewExtUnix::webview())`, remove it from `WindowExtUnix::default_vbox()`, build `gtk::Overlay { GLArea base, webview on top }`, `pack_start` the overlay, `GtkGlRenderer::attach`, start a 16ms `glib::timeout_add_local` render tick, store `Arc<SharedFrame>` in `AppState`. Verify `cargo build --features native-webrtc` (WSL).

**Spike acceptance (owner, CachyOS):** `cargo run --features native-webrtc` → after connect, decoded video renders in the GLArea **under the transparent HUD**, HUD visible/clickable, no flicker. **If re-parenting the live webview fails:** try building the Overlay before the webview via a window-creation hook; else escalate to the Moonlight separate-window model (Phase 7). Record the outcome — it determines whether 6c proceeds as designed.

**Commit** B1/B2/B3 as they pass WSL compile (the spike code is real, just unvalidated):
`spike(rtc): render-mount on the Tauri window (GtkOverlay+GLArea, transparent) — Linux-validate`

---

## 6c — IPC + frontend (interface + acceptance; detailed plan authored after 6a + the 6b spike)

> Per the writing-plans multi-subsystem rule, 6c is specified here at interface +
> acceptance level. Its detailed TDD task-plan is authored once 6a is merged and the
> 6b spike confirms the compositing model (6c's splash/Stream/clip coupling depends on
> what the spike proves). Each unit below maps to a spec section (C1–C10).

- **C1 `AppState` + `rtc_*` commands** — `AppState{ frame_sink: Arc<SharedFrame> (always), #[cfg] rtc: Mutex<Option<RtcHandle>> }`; one `#[tauri::command]` per `rtc_*` with the cfg INSIDE the body (real vs `Err("native unavailable")`); single `generate_handler!`. *Accept:* both builds compile; `rtc_native_available()` returns the right bool; default build has no engine symbols.
- **C2 `rtc_connect` lifecycle** — clone `state.auth` under lock, refuse if `rtc` is Some, `engine::spawn(auth, server_id, play_path, Some(frame_sink))`, `take_events()`, spawn the forwarding task. *Accept:* returns Ok on spawn; failures arrive as terminal `Disconnected`.
- **C3 `RtcEventDto` + forwarding** — serializable DTO; task drains the receiver → `app.emit("rtc_event", dto)`; end-of-stream emits "ended". *Accept:* events reach JS via `listen`.
- **C4 window-close teardown** — `on_window_event` CloseRequested → take handle + `disconnect()` + stop tick. *Accept:* no orphaned console session after close.
- **C5 `ConnectionBackend` interface** — extract the full surface (`connect(XHomeConsole)`, `disconnect`, `requestKeyframe`, `setEncodedTap`, `encodedStreamsAvailable`, `lastSnapshot`, `lastTriggerReason`, `state`, callbacks) implemented by BOTH `ConnectionManager` and `NativeConnection`. *Accept:* `pnpm check` green; store compiles against the interface.
- **C6 `NativeConnection`** — event→callback mapping (incl. terminal/transient, splash synthesis from FirstFrame, `lastTriggerReason` from terminal Disconnected, `encodedStreamsAvailable=false`, `setEncodedTap` no-op), `GamepadPoller` with the native tagged callback, `rtc_event` subscription with a session-generation guard. *Accept:* Vitest unit test of the mapping passes.
- **C7 deterministic store selection** — resolve `rtc_native_available()` before the first connect; gate ConsoleList Connect on a ready flag. *Accept:* on a native build, connect always uses `NativeConnection`.
- **C8 native clip path** — `connectionStore.saveClip()` → `rtcSaveClip()` in native mode; App.svelte clip-attach `$effect` browser-only. *Accept:* the Clip button saves an MP4 natively (live).
- **C9 `Stream.svelte` native branch** — omit `<video>`/autoplay/unmute (inert), splash off store state, hide volume UI natively. *Accept:* no console errors; splash dismisses on FirstFrame.
- **C10 stats mapping + ipc wrappers** — complete `DiagnosticsSnapshot` (baseline + `mapStats`); `ipc/commands.ts` wrappers + `subscribeRtcEvents`. *Accept:* HUD renders native metrics; no undefined-field crashes.

---

## Self-Review

**Spec coverage:** 6a tasks cover spec decisions 2–4 + units A1–A6 (A7 is a flagged live watch-item, no code). 6b covers B1–B3 + decision (render mount). 6c units map 1:1 to spec C1–C10 + decisions 1, 5. ✅
**Placeholder scan:** 6a steps carry concrete code; gated steps name the exact WSL verify command; "READ engine.rs to confirm placement" notes name the exact symbol to check (integration reality, not a placeholder). 6c is intentionally interface-level per the multi-subsystem rule (its detailed plan follows). ✅
**Type consistency:** `take_events`/`request_keyframe`/`EngineCommand::RequestKeyframe`/`spawn(..., play_path, frame_sink)`/`create_session(server_id, play_path)` are used consistently across 6a tasks and referenced by 6c interfaces. ✅
