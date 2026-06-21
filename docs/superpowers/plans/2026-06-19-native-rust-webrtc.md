# Native Rust WebRTC (Linux-first) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## STATUS (updated 2026-06-19, live on CachyOS + real console)
>
> - **Phase 0 — ✅ COMPLETE** (live de-risk passed end-to-end on the Linux box +
>   a real Xbox Series X). See
>   [findings](../specs/2026-06-19-native-webrtc-sdp-findings.md).
>   - **Task 0.1 — DTLS-SRTP confirmed *on the wire*.** Xbox's answer is
>     `a=setup:passive` + `a=fingerprint`, **no `a=crypto`**; the config-JSON
>     `srtp.key` is unused. str0m works unmodified — Risk #1 gate GREEN.
>     `XBOX_DUMP_SDP` hook lives in `xhome.rs::exchange_sdp_offer` (→
>     `<tmp>/xbox-remote-sdp-capture.txt`).
>   - **Task 0.2 — str0m receive→decode PASS.** `examples/rtc_spike.rs` (offerer)
>     connected in ~0.6 s, opened the 4 DCEP channels, ran the Phase-1 handshake,
>     received 189 H.264 + 159 Opus frames, decoded a 1920×1080 PNG of the
>     dashboard. **Spike retained intentionally** (feature-gated example;
>     `required-features=["native-webrtc"]`) as a live Phase-2 engine reference.
>   - **Lib+bin split done.** Was a binary-only crate; added `src/lib.rs`
>     (`pub mod …` + `run()`), `main.rs` is now a thin shim. Unblocks `examples/`
>     AND Phase-2 `tests/` integration tests. `cargo test` → 93/93.
>   - Load-bearing live discoveries (now in the findings doc, must inform Phase 2):
>     (a) **ICE `/ice` is a rendezvous** — `204` until the client POSTs its own
>     candidate; (b) **Xbox won't stream without the data channels** — a
>     channel-less offer got 0 media; (c) str0m emits **Annex-B** H.264 (ffmpeg
>     direct), Xbox sends **L4.2** 1080p, negotiated fine via
>     `level-asymmetry-allowed`.
> - **Phase 1 — ✅ COMPLETE** (pure protocol port, TDD + `insta`, 93 tests).
>   `src/rtc/{input,protocol,clip_tap}.rs`. The `protocol.rs` builders drove the
>   live console **unmodified** during the spike — empirically validated.
> - **Phase 2 — ✅ COMPLETE** (str0m engine + signaling; subagent-driven TDD, plan
>   `docs/superpowers/plans/2026-06-19-native-webrtc-phase2.md`). Built behind the
>   seams: async `Transport`/`UdpTransport`, `XHomeSignaling` adapter, the pure
>   `channels.rs` handshake sequencer + `state.rs` 3/6/9s reconnect ladder (TDD),
>   and the feature-gated `engine.rs` sans-IO loop (`RtcEngine::spawn` on a
>   dedicated thread). **Live-validated:** `tests/rtc_e2e.rs` (XBOX_E2E) connected
>   to the real console, ran the handshake, received ≥100 video AUs. Two-stage
>   review caught + fixed two real engine bugs (reconnect ladder never reset;
>   non-cancellable backoff hung disconnect). 103 pure unit tests green.
> - **Phase 3 — ✅ CODE COMPLETE + ✅ LIVE-VALIDATED** (decode + audio;
>   subagent-driven TDD, plan
>   `docs/superpowers/plans/2026-06-19-native-webrtc-phase3.md`). Software slice:
>   `media/decode_ffmpeg.rs` (`FfmpegDecoder`, H.264 Annex-B → I420 CPU frames,
>   fixture TDD), `media/decode_opus.rs` (`OpusDecoder`, Opus→48k stereo PCM,
>   round-trip TDD), `media/audio_sink.rs` (pure `AudioRing` TDD + `cpal` playback).
>   `engine.rs` decodes received AUs inline (video → count + `FirstFrame` on first
>   *decoded* frame; audio → `cpal` playback). **106 pure tests green; feature
>   build clean.** Review caught + fixed a dropped `set_pts` (A/V-sync bug) and dead
>   over-gating in the engine. ✅ **LIVE-VALIDATED 2026-06-20 on WSL Ubuntu 24.04**
>   (Windows host — NOT the CachyOS box): the real `XBOX_E2E` run connected to the
>   live Series X and the test passed — Connected + FirstFrame + **≥100 *decoded*
>   1080p frames** in 10.3s:
>   `XBOX_E2E=1 XBOX_SERVER_ID=<id> cargo test --features native-webrtc --test rtc_e2e -- --nocapture`
>   ✅ **Audio confirmed by ear on the CachyOS box (2026-06-20):** re-ran the live
>   `XBOX_E2E` here with a 20s hold (`XBOX_E2E_HOLD_SECS=20`, new knob in the test)
>   and the Xbox dashboard audio played cleanly through the default output (cpal →
>   PipeWire). (On WSLg it could NOT be heard — no ALSA card, `cannot find card
>   '0'`; cpal sink fails to open, non-fatal/logged. Bridge with `libasound2-plugins`
>   if WSL audio is ever needed.) Benign startup `non-existing PPS 0`/`no frame!`
>   lines are the mid-stream join before the first keyframe — decode recovers at the
>   IDR. Live-run note: the console can wedge into `WaitingForServerToRegister` after
>   a session; **fully Restart it** to clear (see the gotcha below).
>   **DECISION: HW VA-API decode + zero-copy `FramePixels::Gpu` were deferred** to
>   co-design with the Phase-4 renderer (software 1080p decode is proven; zero-copy
>   only pays off with a GPU renderer). Phase-3 follow-ups: real A/V sync (Phase 5);
>   maybe a dedicated decode thread if the inline decode starves the loop.
> - **NEXT — Phase 4 (Linux render)** (Phase-3 live validation ✅ done 2026-06-20):
>   a `VideoRenderer` presenting `DecodedFrame`s under the transparent HUD
>   (wgpu/gtkglsink), at which point HW decode + zero-copy GPU texture is added.
>   Then Phase 5 stats/keepalive/clip, Phase 6 integration+flag, Phase 7 unify
>   Win/macOS. Carried-forward engine follow-ups (phase-2/3 plans + findings):
>   `Signaling::refresh` for gsToken expiry across long reconnects; bounded event
>   channel before the Phase-6 UI consumer; `play_path` threading.
>
> ### ⚠️ HANDOFF — continuing on a different machine (e.g. Windows)
> All work is on branch **`feat/native-webrtc-linux`** (pushed to origin; PR
> [#15](https://github.com/DRHATL95/xbox-remote/pull/15) → master). A fresh
> instance: `git checkout feat/native-webrtc-linux && git pull`. **OS notes:**
> - `cargo test` (no `--features`) runs the **106 pure tests on any OS** — the
>   `rtc` pure modules (input/protocol/clip_tap/channels/state/signaling-mappers/
>   AudioRing) are codec-free. Use this to verify the port arrived intact.
> - `cargo build --features native-webrtc` needs **str0m + ffmpeg-the-third + cpal
>   + opus**. `ffmpeg-the-third` typically **does NOT build on stock Windows**
>   (needs ffmpeg dev libs + pkg-config/vcpkg wiring) — that's why Phase 1 was done
>   feature-free. **Do not expect the feature build or the live E2E to work on
>   *native* Windows.** The native engine is **Linux-first by design**; on Windows the
>   existing **browser `<video>` path is still the default and works**.
> - **BUT WSL works (validated 2026-06-20).** On a Windows host, **Ubuntu 24.04 in
>   WSL2 both builds `--features native-webrtc` AND runs the live `XBOX_E2E` decode
>   test green** — even on FFmpeg 6.1 (`ffmpeg-the-third` 5.x adapts via cfg-gating;
>   no FFmpeg-8 / Arch parity needed). Recipe: `apt install build-essential
>   pkg-config clang libclang-dev libopus-dev libasound2-dev libavcodec-dev
>   libavformat-dev libavutil-dev libavdevice-dev libavfilter-dev libswscale-dev
>   libswresample-dev gnome-keyring dbus-x11`; bring up an unlocked Secret Service on
>   the session bus (`gnome-keyring-daemon --daemonize --unlock --components=secrets`,
>   needed because `keyring` uses `sync-secret-service`); sign in headlessly with
>   `cargo run --example wsl_login` (the auth-code loopback redirect reaches the WSL
>   listener via WSL2 localhost-forwarding) — it also prints `XBOX_SERVER_ID`; build
>   with `CARGO_TARGET_DIR` on ext4 so the `/mnt/c` 9p mount isn't the bottleneck.
>   Caveats: no audio (WSLg has no ALSA card — add `libasound2-plugins` to bridge to
>   pulse); **Phase 4 render still wants the real box** (WSLg GPU/airspace differs).
> - **Live-run console gotcha (seen 2026-06-20):** Xbox Remote Play allows ONE
>   session at a time and does NOT always tear a failed one down cleanly — firing
>   several `create_session` attempts in a row (e.g. spike + E2E retries) can wedge
>   the console into repeated `InternalServerError … WaitingForServerToRegister`
>   (a NullReferenceException on MS's backend) even though it still lists as
>   `power=On`. NOT a code bug — both the engine (`create_session(..., None)`) and
>   the spike (`..., Some(play_path)`) fail identically once wedged. Fix: **fully
>   Restart the console** (power menu → Restart, not standby) to clear the stuck
>   registration, then re-run. Note `wake_console` currently POSTs a 404, so remote
>   wake can't rouse a standby console (pre-existing gap; separate follow-up).
> - The native-WebRTC effort's natural Windows work is **Phase 7 (unify Windows)** —
>   the hard part is wry/WebView2 "airspace" compositing (see §Phase 7) — and
>   planning/docs. The Linux-dependent steps (Phase 3 live run, Phase 4 render)
>   should be done back on the Linux box.
> - The 1.0 backend (`xhome.rs`) + frontend (`ConnectionManager.ts`) refactors come
>   after the whole native feature.

**Goal:** Move the WebRTC media client out of the browser webview into native Rust so Xbox streaming works on Linux (where WebKitGTK ships *without* WebRTC), with one shared Rust engine that Windows and macOS can later adopt.

**Architecture:** A single cross-platform Rust WebRTC engine (str0m) owns the session: it answers Xbox's SDP offer, runs ICE/DTLS-SRTP, receives the H.264 video + Opus audio, and runs the four data channels. Decoded video is rendered to a native surface **under** the existing transparent Svelte HUD (Linux: transparent WebKitGTK over a wgpu/`gtkglsink` surface). ~80% of the code — transport, the Xbox protocol, the 38-byte input packet, the clip tap, stats, keepalive/reconnect, Opus decode — is platform-agnostic Rust written once. Only the final decode+composite "last mile" is per-OS. Linux ships first behind a feature flag; the proven browser `<video>` path stays the default on Windows/macOS until the native render layer is proven and they're flipped over.

**Tech Stack:** Rust, Tauri 2 / wry 0.55, **str0m 0.20** (WebRTC, sans-IO), **`opus`** crate (audio decode), **gpu-video + wgpu** (HW H.264 decode → texture) with **`ffmpeg-the-third`** fallback, **`muxide`** (existing — clip MP4 mux, now Opus-direct), **`gilrs`** (native gamepad). Reuse: `src/xhome.rs` (session/SDP/ICE/keepalive HTTP) and `src/clip.rs` (XCLP parse + mux). Svelte 5 + TypeScript for the HUD. Tests: `cargo test` (+ `insta` snapshots for wire formats), Vitest for any remaining TS.

**Spec / research:** This plan; backing research captured inline in §Decisions and §Risks. Source code map in §Current Boundary.

**Branch:** `feat/native-webrtc-linux` (off `master`).

**Decision log:** (1) **str0m** over webrtc-rs — webrtc-rs's mature line is frozen (0.17 EOL) and its successor is alpha; str0m is actively maintained, stable (0.20, 2026-05), MIT, sans-IO (full IO control for a single-session desktop client), with a direct receive-and-decode precedent (BitWHIP). (2) **Linux-first, then unify** — Linux is the only broken platform *and* the easy compositing target; Windows is the hard one (Tauri/wry windowed WebView2 hosting → "airspace" occlusion; deferred to the unify phase). (3) Keep **`muxide`** and drop the WebCodecs Opus→AAC transcode (mux Opus directly into MP4 → removes the AAC-priming A/V residual). (4) **Hexagonal / ports-and-adapters** with a sans-IO engine and four trait seams (`Signaling`, `Transport`, `VideoDecoder`/`AudioDecoder`, `VideoRenderer`) — chosen so the platform/codec surface grows by adding adapters, never by editing engine logic, and so the engine is unit-testable with mock transport/signaling. (5) Whole stack behind the **`native-webrtc`** Cargo feature (optional deps) to keep the default build lean. (6) **Offerer** role confirmed (was mis-stated as answerer).

---

## ✅ Make-or-break unknown — RESOLVED (Phase 0, 2026-06-19)

**Verdict: Xbox uses standard DTLS-SRTP. str0m works unmodified. Gate is GREEN.**

Resolved statically (no live capture needed): the shipping app uses the browser's
`new RTCPeerConnection()` + `createOffer()` (`ConnectionManager.ts:547`). Browsers
**only** support DTLS-SRTP — SDES (`a=crypto:`) was removed years ago — so the app,
which works on Windows, proves Xbox xHome accepts DTLS-SRTP. The `srtp.key` in the
config response is therefore *not* a required SDES key for the WebRTC media. The only
crypto reference anywhere in the codebase is `logging.rs` redacting `a=fingerprint`
(a DTLS-SRTP marker); there is no `a=crypto`/SDES handling. str0m derives SRTP keys
from the DTLS handshake — exactly what's needed. *(Confirm by eyeballing one live
offer/answer during the Task 0.2 spike, but it no longer blocks.)*

**Role correction:** we are the **offerer**, not the answerer — the client calls
`createOffer()`, POSTs it, and applies Xbox's `answer`. str0m must use its
**`create_offer`** path (`SdpApi` add-media → `apply()` → send → `accept_answer()`),
not `accept_offer()`. This propagates to Task 0.2 and Phase 2.

---

## Current Boundary (what exists today)

**Already in Rust — reuse as-is** (`src/xhome.rs`, `src/clip.rs`, `src/main.rs` commands):
- `create_session` / session-state polling / `get_session_configuration` (keepalive interval, server details).
- `get_ice_servers` (STUN/TURN parse + Google STUN fallback).
- `exchange_sdp` (POST offer → answer, tolerant of Xbox's multiple response shapes).
- `send_ice_candidate`, `poll_ice_candidates` (handles the `a=` prefix + stringified-array quirks).
- `save_clip` (XCLP parse → `muxide` MP4).

**In browser JS today — must move to Rust** (`ui/src/lib/connection/*`, `ui/src/lib/clip/*`):
- `RTCPeerConnection` lifecycle, transceivers (audio sendrecv, video recvonly), offer/answer, ICE wiring, connection-state machine — `ConnectionManager.ts`.
- The 4 data channels (`chat`/`control`/`message`/`input`), handshake → control-auth → 6 config messages — `dataChannels.ts`, `messages.ts`, `constants.ts`.
- The **38-byte** gamepad/keyboard input packet + 60 Hz poll loop — `input.ts`.
- Encoded-frame **clip tap** (Insertable Streams) + `EncodedTap` ring/assemble — `clip/EncodedTap.ts`.
- Stats sampling (`getStats`) + media-flow watchdog (keyframe nudge → reconnect) — `stats.ts`, `mediaMonitor.ts`.
- `<video>` rendering + autoplay handling — `screens/Stream.svelte`.

**Load-bearing protocol constants** (must be copied byte-exact; from research): input packet `VirtualPhysicality` is **big-endian** while `PhysicalPhysicality` is little-endian; Y-axis is negated; idle micro-pulse `LeftThumbX=4096` (inside game deadzones, detectable by Xbox); handshake `id=be0bfc6d-…`, control `accessKey=4BDB3609-…`; reconnect backoff 3s/6s/9s (tuned to Xbox session expiry). All live in `ui/src/lib/connection/constants.ts` — Phase 1 ports them verbatim.

---

## Target File Structure (new Rust `src/rtc/` module)

**Architecture: hexagonal (ports & adapters) + sans-IO core, feature-gated, one
responsibility per file (≤ ~250 lines).** The `engine` depends only on the four
trait *seams* (`Signaling`, `Transport`, `VideoDecoder`/`AudioDecoder`,
`VideoRenderer`) — never on concrete IO or codecs — so adding an OS, swapping a
decoder, or evolving the protocol never touches engine logic. Status legend:
✅ scaffolded (Phase 0) · ⬜ pending phase.

```
src/rtc/
  mod.rs            ✅ façade: RtcError/Result, RtcEvent (control+stats only, NO frames over IPC), StatsSnapshot
  transport.rs      ✅ SEAM: Transport trait + UdpTransport (mockable → deterministic engine tests)
  signaling.rs      ✅ SEAM: Signaling trait (offerer) + SessionInfo/IceCandidate; XHomeSignaling adapter ⬜ P2
  media/
    mod.rs          ✅ SEAMs: AccessUnit, DecodedFrame, AudioPcm + VideoDecoder/AudioDecoder/VideoRenderer traits
    decode_ffmpeg.rs ⬜ P0/P3: FfmpegDecoder (software + HW fallback) — also the spike decoder
    decode_linux.rs  ⬜ P3: VA-API/NVDEC via gpu-video → wgpu::Texture (zero-copy)
    render_linux.rs  ⬜ P4: transparent WebKitGTK over wgpu surface (gtkglsink/GtkOverlay fallback)
  input.rs          ⬜ P1: 38-byte gamepad packet encoder (PURE, byte-exact) + idle pulse
  protocol.rs       ⬜ P1: message structs (Handshake/Ack, control auth, /streaming/*), serde, constants
  clip_tap.rs       ⬜ P1: encoded-AU ring + keyframe-aligned assemble → reuses src/clip.rs mux
  engine.rs         ⬜ P2: str0m owner (offerer) — socket + poll_output loop, lifecycle state machine
  channels.rs       ⬜ P2: 4 data channels — open order, handshake → control-auth → config, inbound routing
  stats.rs          ⬜ P5: bitrate/fps/freeze counters + watchdog (keyframe nudge → reconnect)
```

The Phase-0 spike (`examples/rtc_spike.rs`) reuses `signaling`/`transport` and
`media::decode_ffmpeg` to prove str0m offer→connect→decode end to end.

- Modify `src/main.rs` — `mod rtc;`, register `rtc::*` commands, init the engine in `setup` behind the `native-webrtc` gate.
- Modify `Cargo.toml` — add `str0m`, `opus`, `gpu-video`/`ffmpeg-the-third`, `wgpu`, `gilrs`, `bytes`; `[features] native-webrtc = []`; `insta` (dev).
- Frontend: `ui/src/lib/ipc/commands.ts` gains thin wrappers (`rtc_connect`, `rtc_disconnect`, events via Tauri channel); `Stream.svelte` gains a native-mode branch (HUD only, no `<video>`); the existing `ConnectionManager` path is retained behind a runtime flag.

> Per the writing-plans multi-subsystem rule: **Phases 0–1 are fully task-detailed below.** Phases 2–7 list concrete interfaces + acceptance criteria; each gets its own detailed task-plan file (`docs/superpowers/plans/2026-06-…-native-webrtc-phaseN.md`) authored at the start of that phase, once Phase 0 has resolved the SRTP/decoder unknowns.

---

## Phase 0 — De-risk (no engine code until these pass)

**Goal:** Prove the two unknowns that can invalidate the whole approach: (a) Xbox SRTP keying mode, (b) str0m can answer + receive + decode one Xbox video frame on Linux.

### Task 0.1: Capture and classify a real Xbox SDP offer

**Files:**
- Modify: `src/xhome.rs` (the `exchange_sdp` path) — add a one-shot debug dump of the raw answer SDP behind `XBOX_DUMP_SDP=1`.
- Create: `docs/superpowers/specs/2026-06-19-native-webrtc-sdp-findings.md` (record the result).

- [ ] **Step 1: Add the env-gated SDP dump.** In `exchange_sdp`, when `std::env::var_os("XBOX_DUMP_SDP").is_some()`, write the full offer+answer SDP to `app_log_dir()/sdp-capture.txt` (this is local-only diagnostics; the answer SDP contains the DTLS fingerprint, not a long-lived secret — still gitignore the file).
- [ ] **Step 2: Run a real session** with `XBOX_DUMP_SDP=1 cargo run`, sign in, connect to the console once (the browser path still works on the dev machine? No — WebKitGTK has no WebRTC, so the offer is generated browser-side and never reaches Xbox). **Therefore:** generate the offer with str0m instead — see Task 0.2 — and capture Xbox's *answer*. Sequence Task 0.2 first if needed; the goal is to read **Xbox's answer SDP crypto lines**.
- [ ] **Step 3: Classify.** Grep the captured answer for `a=fingerprint:` + `a=setup:` (⇒ DTLS-SRTP, str0m works unmodified) vs `a=crypto:` (⇒ SDES, requires str0m SRTP fork). Record verdict + the offer's codecs (`a=rtpmap` H.264 profile-level-id; Opus) and `a=mid` ordering in the findings doc.
- [ ] **Step 4: Decision gate.** If DTLS-SRTP → proceed. If SDES → **STOP**, escalate: re-scope to (a) fork str0m SRTP, or (b) reconsider gstreamer `webrtcbin` (supports SDES) as the transport. Do not start Phase 2 until this is green.

### Task 0.2: str0m receive→decode spike (throwaway binary)

**Files:**
- Create: `examples/rtc_spike.rs` (a `cargo run --example rtc_spike` throwaway; deleted at end of Phase 0).

- [ ] **Step 1: Add deps** to `Cargo.toml`: `str0m`, `opus`, `ffmpeg-the-third` (software decode is fine for the spike), `bytes`. Run `cargo build` — expect success.
- [ ] **Step 2: Build the answerer.** Using the captured offer from 0.1 (or live via `xhome.rs` signaling), create a str0m `Rtc`, `accept_offer(offer)`, produce the answer, POST it via `exchange_sdp`, feed remote ICE from `poll_ice_candidates`, and run the sans-IO loop (`handle_input` for UDP, drain `poll_output` → `Transmit`/`Timeout`/`Event`). Log every `Event` variant.
- [ ] **Step 3: Assert connectivity.** Expected log: ICE → DTLS connected, then `Event::MediaData` for the video MID arriving steadily. **Acceptance:** ≥ 100 video `MediaData` events in 5 s.
- [ ] **Step 4: Decode one frame.** Feed the H.264 access units (reassembled Annex-B) to `ffmpeg-the-third` H.264 decoder; on the first decoded frame, write a PNG to `/tmp/xbox_frame.png`. **Acceptance:** `/tmp/xbox_frame.png` shows the Xbox dashboard. Send a PNG to the user.
- [ ] **Step 5: Record findings** (codec params, frame cadence, any depacketization quirks vs `scottlamb/retina`) in the findings doc. Delete `examples/rtc_spike.rs` (knowledge captured; engine gets the real impl in Phase 2).
- [ ] **Step 6: Commit** the findings doc + the `XBOX_DUMP_SDP` hook.

```bash
git add docs/superpowers/specs/2026-06-19-native-webrtc-sdp-findings.md src/xhome.rs Cargo.toml Cargo.lock
git commit -m "chore(rtc): phase 0 de-risk — SDP crypto classified, str0m receive+decode spike proven"
```

---

## Phase 1 — Pure protocol port (no IO, fully TDD now)

**Goal:** Port the byte-exact, side-effect-free protocol pieces to Rust with snapshot tests, independent of str0m. These are correct to write *today* (no Phase 0 dependency) and become the engine's building blocks.

### Task 1.1: The 38-byte input packet encoder

**Files:**
- Create: `src/rtc/input.rs`
- Modify: `src/rtc/mod.rs` (add `pub mod input;`), `src/main.rs` (add `mod rtc;`)
- Test: inline `#[cfg(test)] mod tests` in `src/rtc/input.rs` (+ `insta` snapshot)

- [ ] **Step 1: Write the failing test** (byte layout from `ui/src/lib/connection/input.ts`; note the BE quirk):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_frame_layout() {
        let f = GamepadFrame::neutral();
        let bytes = encode_gamepad(&f, /*sequence*/ 7, /*timestamp_ms*/ 1234.5);
        assert_eq!(bytes.len(), 38);
        assert_eq!(u16::from_le_bytes([bytes[0], bytes[1]]), REPORT_TYPE_GAMEPAD); // 2
        assert_eq!(u32::from_le_bytes([bytes[2],bytes[3],bytes[4],bytes[5]]), 7);  // sequence
        assert_eq!(bytes[14], 1); // frameCount
        assert_eq!(bytes[15], 0); // gamepadIndex
        // PhysicalPhysicality @30..34 little-endian == 1
        assert_eq!(u32::from_le_bytes([bytes[30],bytes[31],bytes[32],bytes[33]]), 1);
        // VirtualPhysicality @34..38 BIG-endian == 1  (load-bearing quirk!)
        assert_eq!(u32::from_be_bytes([bytes[34],bytes[35],bytes[36],bytes[37]]), 1);
    }

    #[test]
    fn y_axis_is_negated() {
        let mut f = GamepadFrame::neutral();
        f.left_thumb_y = 10000;
        let bytes = encode_gamepad(&f, 0, 0.0);
        assert_eq!(i16::from_le_bytes([bytes[20], bytes[21]]), -10000); // negated per protocol
    }

    #[test]
    fn idle_pulse_uses_4096() {
        let f = GamepadFrame::idle_pulse();
        assert_eq!(f.left_thumb_x, 4096); // inside deadzone, detectable by Xbox
    }
}
```

- [ ] **Step 2: Run, verify it fails.** `cargo test -p xbox-remote rtc::input` → FAIL (unresolved `GamepadFrame`).
- [ ] **Step 3: Implement** `src/rtc/input.rs` — `pub const REPORT_TYPE_GAMEPAD: u16 = 2;`, `pub struct GamepadFrame { buttons:u16, left_thumb_x:i16, left_thumb_y:i16, right_thumb_x:i16, right_thumb_y:i16, left_trigger:u16, right_trigger:u16 }` with `neutral()` / `idle_pulse()`, and `pub fn encode_gamepad(f:&GamepadFrame, sequence:u32, timestamp_ms:f64) -> [u8;38]` writing the exact offsets (Y/RY negated; `@30` LE `1`; `@34` BE `1`). Also `pub fn encode_client_metadata() -> [u8;15]` (the once-on-start packet).
- [ ] **Step 4: Run, verify pass.** `cargo test -p xbox-remote rtc::input` → PASS; review the `insta` snapshot of a fully-pressed frame and `cargo insta accept`.
- [ ] **Step 5: Commit.**

```bash
git add src/rtc/ src/main.rs Cargo.toml && git commit -m "feat(rtc): byte-exact 38-byte input packet encoder (TDD)"
```

### Task 1.2: Data-channel protocol messages

**Files:**
- Create: `src/rtc/protocol.rs` (+ `pub mod protocol;` in `mod.rs`)
- Test: inline tests + `insta` JSON snapshots

- [ ] **Step 1: Failing test** — assert the Handshake JSON, control authorization (`accessKey=4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E`), `videoKeyframeRequested`, `gamepadChanged`, and each of the 6 `/streaming/*` config messages serialize to the exact bytes Xbox expects (copy expected JSON from `ui/src/lib/connection/dataChannels.ts` / `messages.ts`). Use `insta::assert_json_snapshot!`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the serde structs + constructors (`Handshake::new()`, `control_authorization()`, `keyframe_request()`, `config_messages() -> Vec<DcMessage>`), and an inbound `parse_message(&[u8]) -> InboundMsg` enum covering `HandshakeAck`, `serverInitiatedDisconnect` (WarningForBeingIdle / KickForBeingIdle), and unknown.
- [ ] **Step 4: Run → PASS;** `cargo insta accept`.
- [ ] **Step 5: Commit.** `feat(rtc): data-channel protocol messages + parser (TDD)`

### Task 1.3: Clip encoded-AU ring + keyframe-aligned assemble

**Files:**
- Create: `src/rtc/clip_tap.rs` (+ `pub mod clip_tap;`)
- Test: inline tests

- [ ] **Step 1: Failing test** — push synthetic H.264 AUs (IDR + P frames) with RTP timestamps into `ClipRing::new(retain_secs)`, then `assemble()` and assert: window starts at the last IDR before the cut, SPS/PPS are prepended, A/V share one wall-clock origin (port `EncodedTap.ts` semantics — RTP 90 kHz video / 48 kHz audio → shared origin), and old frames past `retain_secs` are evicted.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `ClipRing` (two ring buffers, keyframe index, `push_video(au, rtp_ts)`, `push_audio(opus, rtp_ts)`, `assemble() -> AssembledClip`). Reuse `src/clip.rs` for the final mux — `assemble()` produces the struct that `clip::mux_to_mp4` already consumes; **mux Opus directly** (drop AAC transcode).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `feat(rtc): native clip ring + keyframe-aligned assemble (TDD)`

---

## Phase 2 — str0m engine + signaling (detailed plan authored after Phase 0)

**Interface:**
```rust
pub struct RtcEngine { /* owns Rtc, UdpSocket, state */ }
pub enum RtcEvent { Connecting, Connected, FirstFrame, VideoFrame(DecodedFrame),
                    AudioFrame(Pcm), Stats(StatsSnapshot), Disconnected(Reason) }
impl RtcEngine {
    pub async fn connect(server_id: &str, app: AppHandle) -> Result<Self>;
    pub fn send_input(&self, frame: GamepadFrame);
    pub async fn disconnect(self);
}
```
**Scope:** the sans-IO loop (socket ↔ `handle_input`/`poll_output`), `accept_offer` using Phase-0 findings, reuse `xhome.rs` for SDP/ICE/keepalive, the 4 data channels (Phase 1.2) with the handshake→auth→config sequence, the connection-state machine + reconnect backoff (3s/6s/9s), and input send (Phase 1.1) driven by `gilrs` at 60 Hz.
**Acceptance:** headless integration test connects to a real console (gated behind `XBOX_E2E=1`), reaches `Connected`, exchanges the handshake, and emits ≥ 5 s of `VideoFrame` events; reconnect fires on simulated socket drop.

## Phase 3 — Decode pipeline (Linux HW)

**Interface:** `trait VideoDecoder { fn feed(&mut self, au: &[u8], pts: u64); fn poll(&mut self) -> Option<DecodedFrame>; }` + Opus via the `opus` crate.
**Scope:** `gpu-video` (VA-API/NVDEC) → `wgpu::Texture` zero-copy; `ffmpeg-the-third` software/HW fallback, capability-gated like `moonlight-qt`'s renderer state machine.
**Acceptance:** decodes the live stream at 1080p60 with HW path on this CachyOS box (VA-API), SW fallback verified by forcing `XBOX_FORCE_SW_DECODE=1`; no GPU→CPU readback on the HW path.

## Phase 4 — Linux render + HUD overlay

**Interface:** `trait VideoRenderer { fn present(&mut self, frame: &DecodedFrame); fn resize(&mut self, w:u32,h:u32); }`
**Scope:** transparent WebKitGTK (`set_background_color` alpha 0 + RGBA visual + app-paintable) over the window's wgpu surface; fallback to `gtkglsink` in a `GtkOverlay`. Reach the GTK window via tao `WindowExtUnix::gtk_window()`. Keep the existing `WEBKIT_DISABLE_DMABUF_RENDERER` / `GDK_BACKEND=x11` workarounds; **target X11 first**, Wayland best-effort. Dynamic whole-window `set_ignore_cursor_events` toggling for click-through over transparent HUD regions.
**Acceptance:** Xbox video renders under the live Svelte HUD on X11 at 1080p60; HUD controls remain clickable; stats panel shows real bitrate/fps from Phase 2.

## Phase 5 — Wire the rest (stats, keepalive, idle, clip, reconnect)

**Scope:** stats watchdog (keyframe nudge at 4s/7s → reconnect at 10s — port `mediaMonitor.ts`); API keepalive (reuse `send_session_keepalive`) + input-channel idle micro-pulse (`LeftThumbX=4096`); wire `clip_tap` (Phase 1.3) to the live AU stream and the existing `save_clip`/`muxide` path.
**Acceptance:** a 60 s idle session stays alive; pulling the stream triggers nudge→reconnect; "Save clip" produces a playable fast-start MP4 from the native ring.

## Phase 6 — Integration, feature flag, end-to-end Linux

**Scope:** `[features] native-webrtc`; runtime flag chooses native engine vs browser `ConnectionManager`; `Stream.svelte` renders HUD-only in native mode (no `<video>`); typed `rtc_*` IPC + a Tauri event channel for `RtcEvent`. CI builds the Linux AppImage with `--features native-webrtc`.
**Acceptance:** fresh AppImage on CachyOS streams end-to-end (sign-in → console list → connect → video+audio+input+clip). Update CLAUDE.md (architecture + the WebKitGTK-no-WebRTC rationale).

## Phase 7 — Unify Windows + macOS (separate plan)

**Scope:** flip Windows/macOS onto the same engine. The hard part is Windows compositing — Tauri/wry uses *windowed* WebView2 (airspace occlusion); options: (a) patch/fork wry to `CreateCoreWebView2CompositionController` (visual hosting, video visual under the WebView2 visual in a DirectComposition tree), or (b) **Moonlight's separate-window model** (native video window + transparent always-on-top HUD webview) as the lower-risk fallback. macOS: WKWebView layer over a Metal/wgpu surface. Authored as its own plan after Phase 6 ships.

---

## Risks & Mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Xbox uses SDES external SRTP key (str0m can't inject) | **Make-or-break** | **Phase 0 Task 0.1** classifies the offer before any engine work; SDES → fork str0m SRTP or switch to gstreamer `webrtcbin`. |
| 2 | Windows webview "airspace" occludes native video | High | Deferred to Phase 7; separate-window fallback proven by Moonlight. |
| 3 | `gpu-video` is pre-1.0, single-vendor, no macOS | Medium | Capability-gate; keep `ffmpeg-the-third` decode path always; macOS uses ffmpeg/VideoToolbox. |
| 4 | str0m has no adaptive jitter buffer | Medium | Start with fixed depacketize buffer (LAN-grade like today); add reorder/jitter handling if internet play needs it. |
| 5 | Wayland/NVIDIA DMA-BUF fragility | Medium | Keep existing X11-first workarounds; Wayland best-effort. |
| 6 | Reference repos are GPL/unlicensed (`stratix`, `xcloud-rs`) | Low | Port *concepts/protocol docs*, not lines; clean-room the engine. |
| 7 | Big effort, regressions on the working browser path | Medium | Feature flag; browser path stays default on all platforms until native proves out on Linux. |

## Testing Strategy

- **Pure units (Phase 1):** `cargo test` + `insta` snapshots for every wire format (input packet, DC messages, clip assemble) — these are the load-bearing byte layouts.
- **Spike (Phase 0):** visual proof (decoded PNG) + connectivity assertions.
- **Engine (Phase 2+):** `XBOX_E2E=1`-gated integration test against a real console; unit tests for the state machine/reconnect with a mock socket.
- **Manual end-to-end (Phase 6):** the `/run` skill on the built AppImage; verify video+audio+input+clip; watch the new structured logs (the logging subsystem already captures `ui::connection` + `xbox_remote::xhome` on one timeline — invaluable here).

## Open Questions (resolve as noted)

1. **SRTP keying mode** — Phase 0 Task 0.1. *(blocks everything)*
2. **H.264 profile/level** Xbox actually offers (decoder capability gating) — Phase 0 Task 0.2.
3. **Does Xbox renegotiate** mid-session (new offer) or only ICE-restart? — observe in Phase 2 E2E.
4. **Audio output sink** in native mode (the browser played Opus via `<video>`; native needs `cpal`/system audio) — fold into Phase 3 (add `cpal` if confirmed).
5. **Gamepad on Linux** — `gilrs` vs the browser Gamepad API; keyboard mapping path when no controller — Phase 2.
```
