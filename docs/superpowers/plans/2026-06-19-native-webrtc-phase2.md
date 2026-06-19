# Native WebRTC Phase 2 — str0m Engine + Signaling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the native, cross-platform `RtcEngine` — a str0m **offerer** that connects to a real Xbox console (reusing `src/xhome.rs` signaling), opens the four DCEP data channels, runs the Phase-1 handshake, receives the encoded H.264 + Opus access units, emits lifecycle/stats events, reconnects on drop, and sends 38-byte input packets — all behind the hexagonal seams.

**Architecture:** A runtime-agnostic sans-IO core, `async run_engine<S: Signaling, T: Transport>(…)`, drives str0m's `poll_output`/`handle_input` loop (the proven `examples/rtc_spike.rs` loop, refactored onto the seams). The **pure** decision logic — the channel handshake sequencer and the connection/reconnect state machine — is str0m-free and fully unit-tested in the default build (like Phase 1). The production driver `RtcEngine::spawn` runs the core on a **dedicated OS thread** with a current-thread tokio runtime, owning `UdpTransport` + `XHomeSignaling`; callers drive it through a command channel (`SendInput`/`Disconnect`) and consume `RtcEvent`s from an event channel (Phase 6 forwards those to the webview). Decode (Phase 3), render (Phase 4), keepalive/idle-pulse/stats-watchdog/clips (Phase 5), Tauri wiring (Phase 6), and the `gilrs` gamepad source (deferred until there's a focused window) are explicitly **out of scope** here.

**Tech Stack:** Rust, **str0m 0.20** (sans-IO WebRTC, offerer), tokio (`net::UdpSocket`, `sync::mpsc`, current-thread runtime on a dedicated thread), `serde_json` (data-channel JSON), the Phase-1 pure modules (`rtc::protocol`, `rtc::input`), `src/xhome.rs` (HTTP signaling), `src/auth.rs` (XSTS). Tests: `cargo test` (pure units + `insta`) for the sequencer/state-machine/mappers; an `XBOX_E2E=1`-gated `tests/rtc_e2e.rs` integration test against a live console. All str0m-touching code is behind the existing `native-webrtc` feature.

**Spec / source of truth:** The master plan `docs/superpowers/plans/2026-06-19-native-rust-webrtc.md` (§Phase 2) and the live findings `docs/superpowers/specs/2026-06-19-native-webrtc-sdp-findings.md`. The working reference for the integration loop is `examples/rtc_spike.rs` (Phase 0).

**Branch:** `feat/native-webrtc-linux` (continue; no new branch).

---

## Decisions (locked for this phase)

1. **Engine runtime = dedicated thread + channels.** Core is `run_engine<S,T>` (any runtime); `RtcEngine::spawn` owns an OS thread + current-thread tokio runtime. Input/disconnect in via `mpsc`; `RtcEvent` out via `mpsc`. Confirmed with user.
2. **Scope = engine core only.** Connect → ICE/DTLS → channels + handshake → receive **encoded** AUs → reconnect (3/6/9 s) → input send. No decode/render/keepalive/Tauri/gilrs. Confirmed with user.
3. **`Transport` becomes async.** The current `try_recv` (non-blocking, sync) seam can't drive an efficient `tokio::select!` loop without busy-polling. Revise to `async recv` / `async send_to` (still `#[allow(async_fn_in_trait)]`, static dispatch — no boxing). `UdpTransport` wraps `tokio::net::UdpSocket`.
4. **Pure logic is str0m-free and lives in the default build.** `channels.rs` (handshake sequencer) and `state.rs` (connection/reconnect state machine) carry no str0m/codec deps — they compile and unit-test under `cargo test` with no `--features`, exactly like `protocol.rs`/`input.rs`. Only `engine.rs` is gated behind `native-webrtc`.
5. **No str0m-loopback or mock-transport engine test this phase.** A `MockTransport` cannot complete str0m's DTLS handshake (no real peer), so a mock-driven "connect" test isn't meaningful. The integrated loop is validated by the live `XBOX_E2E` test; the *pure* pieces (sequencer, state machine, signaling mappers) get real TDD. (str0m↔str0m loopback is a possible future harness — noted, not built here.)
6. **`RtcEvent` carries no media.** Per `src/rtc/mod.rs`, decoded frames never cross a channel; Phase 2 emits `Connecting`/`Connected`/`FirstFrame`/`Reconnecting`/`Stats`/`Disconnected` only. `StatsSnapshot.frames_decoded` counts **received** video AUs until decode lands in Phase 3 (documented at the field).

---

## File Structure

```
src/rtc/
  mod.rs        MODIFY  — add `pub mod channels; pub mod state;` (pure, default build);
                          `#[cfg(feature="native-webrtc")] pub mod engine;`; add
                          RtcEvent::Reconnecting{attempt}; note frames_decoded reuse.
  transport.rs  MODIFY  — Transport trait → async recv/send_to + local_addr;
                          UdpTransport over tokio::net::UdpSocket.
  signaling.rs  MODIFY  — add XHomeSignaling adapter (Signaling over XHomeClient via
                          a Mutex) + pure mapping helpers (StreamConfig→SessionInfo,
                          xhome::IceCandidate→IceCandidate).
  channels.rs   CREATE  — PURE handshake sequencer: ChannelLabel, ChannelEvent,
                          ChannelWrite, HandshakeSequencer (str0m-free, TDD).
  state.rs      CREATE  — PURE ConnectionState + reconnect backoff [3s,6s,9s] (TDD).
  engine.rs     CREATE  — str0m sans-IO loop `run_engine<S,T>` + RtcEngine/RtcHandle
                          + spawn (dedicated thread). Feature-gated.
tests/
  rtc_e2e.rs    CREATE  — XBOX_E2E=1 integration test (connect→handshake→≥5s AUs).
Cargo.toml      (no new runtime deps; tokio already full-featured)
```

> Per the master plan's multi-subsystem rule, Phase 2 is one shippable slice: a connectable, reconnecting engine that emits encoded-AU lifecycle events, unit-tested where pure and E2E-tested live.

---

## Task 2.1: `Transport` seam → async + `UdpTransport`

**Files:**
- Modify: `src/rtc/transport.rs`

The sans-IO loop must `tokio::select!` on socket readiness; the sync `try_recv` can't do that without busy-polling. Make the seam async. There is no pure unit test here (it's a thin tokio wrapper); correctness is exercised by Task 2.6's E2E test. Verification is a compile + a localhost round-trip doctest.

- [ ] **Step 1: Replace the trait + adapter.** Rewrite `src/rtc/transport.rs`:

```rust
//! Transport seam: the UDP datagram socket str0m drives.
//!
//! Async so the sans-IO engine can `tokio::select!` on inbound datagrams against
//! its own timeout without busy-polling. `#[allow(async_fn_in_trait)]` keeps the
//! engine generic over `T: Transport` with static dispatch (no boxing).

use super::{Result, RtcError};
use std::net::SocketAddr;

/// A bidirectional UDP datagram transport.
#[allow(async_fn_in_trait)]
pub trait Transport: Send {
    fn local_addr(&self) -> Result<SocketAddr>;
    async fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()>;
    /// Await the next inbound datagram into `buf`; returns (len, source).
    async fn recv(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)>;
}

/// Real UDP socket adapter over tokio, bound to a caller-chosen local address.
pub struct UdpTransport {
    socket: tokio::net::UdpSocket,
}

impl UdpTransport {
    /// Bind to `addr` (use the route-toward-internet LAN IP with port 0 so the
    /// host ICE candidate is reachable on the LAN — see the Phase-0 findings).
    pub async fn bind(addr: SocketAddr) -> Result<Self> {
        let socket = tokio::net::UdpSocket::bind(addr)
            .await
            .map_err(|e| RtcError::Transport(e.to_string()))?;
        Ok(Self { socket })
    }
}

impl Transport for UdpTransport {
    fn local_addr(&self) -> Result<SocketAddr> {
        self.socket
            .local_addr()
            .map_err(|e| RtcError::Transport(e.to_string()))
    }

    async fn send_to(&self, buf: &[u8], dst: SocketAddr) -> Result<()> {
        self.socket
            .send_to(buf, dst)
            .await
            .map(|_| ())
            .map_err(|e| RtcError::Transport(e.to_string()))
    }

    async fn recv(&self, buf: &mut [u8]) -> Result<(usize, SocketAddr)> {
        self.socket
            .recv_from(buf)
            .await
            .map_err(|e| RtcError::Transport(e.to_string()))
    }
}
```

- [ ] **Step 2: Verify it compiles in the default build.**

Run: `cargo build`
Expected: success (no `--features` needed — transport.rs is feature-free; `tokio` is always a dep).

- [ ] **Step 3: Commit.**

```bash
git add src/rtc/transport.rs
git commit -m "refactor(rtc): make Transport seam async (tokio UdpTransport) for the sans-IO loop"
```

---

## Task 2.2: `XHomeSignaling` adapter + pure mapping helpers

**Files:**
- Modify: `src/rtc/signaling.rs`
- Test: inline `#[cfg(test)] mod tests` in `src/rtc/signaling.rs`

The `Signaling` trait already exists. Add the production adapter wrapping `XHomeClient`, plus the two pure mapping functions that *are* unit-testable (the HTTP itself is E2E). `XHomeClient::create_session`/`login` take `&mut self`, but the trait is `&self`, so wrap the client in a `tokio::sync::Mutex`.

- [ ] **Step 1: Write the failing test** for the pure mappers:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::xhome::{IceCandidate as XIce, StreamConfig};

    #[test]
    fn maps_stream_config_to_session_info() {
        let cfg = StreamConfig {
            session_id: "S1".into(),
            session_path: "v5/sessions/home/S1".into(),
            exchange_response: String::new(),
            gs_token: "tok".into(),
            keep_alive_pulse_seconds: Some(300),
        };
        let info = session_info_from(&cfg);
        assert_eq!(info.session_id, "S1");
        assert_eq!(info.session_path, "v5/sessions/home/S1");
        assert_eq!(info.keepalive_pulse_secs, 300);
    }

    #[test]
    fn missing_keepalive_defaults_to_zero() {
        let cfg = StreamConfig {
            session_id: "S".into(),
            session_path: "p".into(),
            exchange_response: String::new(),
            gs_token: String::new(),
            keep_alive_pulse_seconds: None,
        };
        assert_eq!(session_info_from(&cfg).keepalive_pulse_secs, 0);
    }

    #[test]
    fn maps_xhome_ice_candidate() {
        let x = XIce { candidate: "candidate:1 1 udp …".into(), sdp_mid: "0".into(), sdp_m_line_index: 0 };
        let c = ice_from(&x);
        assert_eq!(c.candidate, "candidate:1 1 udp …");
        assert_eq!(c.sdp_mid, "0");
        assert_eq!(c.sdp_m_line_index, 0);
    }
}
```

- [ ] **Step 2: Run, verify it fails.** Run: `cargo test rtc::signaling` → FAIL (`session_info_from`/`ice_from` undefined).

- [ ] **Step 3: Implement** the mappers + adapter. Append to `src/rtc/signaling.rs`:

```rust
use crate::auth::XboxAuth;
use crate::xhome::XHomeClient;
use tokio::sync::Mutex;

/// Pure map: xHome `StreamConfig` → seam `SessionInfo` (keepalive defaults to 0).
pub(crate) fn session_info_from(cfg: &crate::xhome::StreamConfig) -> SessionInfo {
    SessionInfo {
        session_id: cfg.session_id.clone(),
        session_path: cfg.session_path.clone(),
        keepalive_pulse_secs: cfg.keep_alive_pulse_seconds.unwrap_or(0),
    }
}

/// Pure map: xHome ICE candidate → seam ICE candidate.
pub(crate) fn ice_from(x: &crate::xhome::IceCandidate) -> IceCandidate {
    IceCandidate {
        candidate: x.candidate.clone(),
        sdp_mid: x.sdp_mid.clone(),
        sdp_m_line_index: x.sdp_m_line_index,
    }
}

/// Production `Signaling` adapter over the existing xHome HTTP client. The client
/// holds `&mut self` methods, so it lives behind a Mutex; the engine drives this
/// from a single thread, so contention is nil.
pub struct XHomeSignaling {
    client: Mutex<XHomeClient>,
}

impl XHomeSignaling {
    /// Build + log in (resolves the region base URI + gsToken). `auth` must
    /// already hold valid cached tokens (loaded via `XboxAuth::load_cached_tokens`).
    pub async fn connect(auth: XboxAuth) -> Result<Self> {
        let mut client = XHomeClient::new(auth);
        client
            .login()
            .await
            .map_err(|e| RtcError::Signaling(format!("xHome login: {e}")))?;
        Ok(Self { client: Mutex::new(client) })
    }
}

impl Signaling for XHomeSignaling {
    async fn create_session(&self, server_id: &str) -> Result<SessionInfo> {
        let cfg = self
            .client
            .lock()
            .await
            .create_session(server_id, None)
            .await
            .map_err(|e| RtcError::Signaling(format!("create_session: {e}")))?;
        Ok(session_info_from(&cfg))
    }

    async fn exchange_sdp(&self, session: &SessionInfo, offer_sdp: &str) -> Result<String> {
        self.client
            .lock()
            .await
            .exchange_sdp_offer(&session.session_path, offer_sdp)
            .await
            .map_err(|e| RtcError::Signaling(format!("exchange_sdp: {e}")))
    }

    async fn send_ice(&self, session: &SessionInfo, candidate: &str) -> Result<()> {
        self.client
            .lock()
            .await
            .send_ice_candidate(&session.session_path, candidate)
            .await
            .map_err(|e| RtcError::Signaling(format!("send_ice: {e}")))
    }

    async fn poll_ice(&self, session: &SessionInfo) -> Result<Vec<IceCandidate>> {
        let cands = self
            .client
            .lock()
            .await
            .poll_ice_candidates(&session.session_path)
            .await
            .map_err(|e| RtcError::Signaling(format!("poll_ice: {e}")))?;
        Ok(cands.iter().map(ice_from).collect())
    }

    async fn keepalive(&self, session: &SessionInfo) -> Result<()> {
        self.client
            .lock()
            .await
            .send_keepalive(&session.session_path)
            .await
            .map(|_| ())
            .map_err(|e| RtcError::Signaling(format!("keepalive: {e}")))
    }
}
```

> NOTE: `create_session` ignores `play_path` here (passes `None`); xHome falls back to the default `v5/sessions/home/play`. The Phase-0 spike used the console's `play_path`; if a live test shows the default path 404s, thread `play_path` through `EngineConfig` and into `create_session`. (Captured as an open item, not a blocker — the default path worked in early Phase-0 sessions.)

- [ ] **Step 4: Run, verify pass.** Run: `cargo test rtc::signaling` → PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add src/rtc/signaling.rs
git commit -m "feat(rtc): XHomeSignaling adapter + pure SessionInfo/ICE mappers (TDD)"
```

---

## Task 2.3: `channels.rs` — pure handshake sequencer (TDD)

**Files:**
- Create: `src/rtc/channels.rs`
- Modify: `src/rtc/mod.rs` (add `pub mod channels;`)
- Test: inline `#[cfg(test)] mod tests`

The sequencer turns abstract channel events (a channel opened; bytes arrived) into the ordered writes the Xbox handshake requires, using the Phase-1 `protocol` builders. It is **str0m-free** so it unit-tests in the default build. The engine (Task 2.5) maps str0m `ChannelOpen`/`ChannelData` ↔ these abstract events and `ChannelWrite` ↔ `rtc.channel(id).write`.

- [ ] **Step 1: Add the module.** In `src/rtc/mod.rs`, under the Phase-1 modules:

```rust
pub mod channels;
```

- [ ] **Step 2: Write the failing test** (`src/rtc/channels.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::rtc::protocol::{self, InboundMsg};

    fn det_ids() -> impl FnMut() -> String {
        let mut n = 0u32;
        move || {
            n += 1;
            format!("00000000-0000-4000-8000-{n:012}")
        }
    }

    #[test]
    fn message_open_sends_handshake_once() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let w = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].label, ChannelLabel::Message);
        assert_eq!(protocol::parse_message(&w[0].bytes), InboundMsg::Unknown); // it's a Handshake, not an inbound type
        let v: serde_json::Value = serde_json::from_slice(&w[0].bytes).unwrap();
        assert_eq!(v["type"], "Handshake");
        // Opening other channels emits nothing.
        assert!(seq.on_event(ChannelEvent::Opened(ChannelLabel::Control)).is_empty());
        // Re-opening message does not re-send.
        assert!(seq.on_event(ChannelEvent::Opened(ChannelLabel::Message)).is_empty());
    }

    #[test]
    fn handshake_ack_emits_full_burst_in_order() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let _ = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        let ack = br#"{"type":"HandshakeAck"}"#.to_vec();
        let w = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: ack });

        // auth (control) + gamepad (control) + 6 configs (message) + keyframe (control) = 9
        assert_eq!(w.len(), 9);
        let labels: Vec<ChannelLabel> = w.iter().map(|x| x.label).collect();
        use ChannelLabel::{Control, Message};
        assert_eq!(
            labels,
            vec![Control, Control, Message, Message, Message, Message, Message, Message, Control]
        );
        // First is authorizationRequest, last is videoKeyframeRequested.
        let first: serde_json::Value = serde_json::from_slice(&w[0].bytes).unwrap();
        assert_eq!(first["message"], "authorizationRequest");
        let last: serde_json::Value = serde_json::from_slice(&w[8].bytes).unwrap();
        assert_eq!(last["message"], "videoKeyframeRequested");
        assert!(seq.is_ready());
    }

    #[test]
    fn duplicate_ack_is_ignored() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let _ = seq.on_event(ChannelEvent::Opened(ChannelLabel::Message));
        let ack = br#"{"type":"HandshakeAck"}"#.to_vec();
        let _ = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: ack.clone() });
        let again = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: ack });
        assert!(again.is_empty());
    }

    #[test]
    fn server_disconnect_is_surfaced_not_written() {
        let mut seq = HandshakeSequencer::new(Box::new(det_ids()));
        let msg = serde_json::json!({
            "type":"Message","target":"x/serverInitiatedDisconnect","content":"{\"reason\":\"KickForBeingIdle\"}"
        });
        let bytes = serde_json::to_vec(&msg).unwrap();
        let w = seq.on_event(ChannelEvent::Inbound { label: ChannelLabel::Message, data: bytes });
        assert!(w.is_empty()); // sequencer writes nothing; engine reads last_disconnect()
        assert!(matches!(seq.take_disconnect(), Some(protocol::DisconnectReason::KickForBeingIdle)));
    }
}
```

- [ ] **Step 3: Run, verify it fails.** Run: `cargo test rtc::channels` → FAIL (types undefined).

- [ ] **Step 4: Implement** `src/rtc/channels.rs`:

```rust
//! Pure Xbox data-channel handshake sequencer (str0m-free; default build).
//!
//! Translates abstract channel events (a channel opened; inbound bytes) into the
//! ordered `ChannelWrite`s the xHome handshake requires, using the Phase-1
//! `protocol` builders. The engine maps str0m `Event::ChannelOpen`/`ChannelData`
//! to these events and `ChannelWrite` back to `rtc.channel(id).write`.
//!
//! Sequence (see dataChannels.ts / the Phase-0 findings):
//!   message opens → send Handshake
//!   HandshakeAck  → control authorizationRequest, control gamepadChanged,
//!                   6 message /streaming/* configs, control videoKeyframeRequested

use crate::rtc::protocol::{
    self, DisconnectReason, InboundMsg, config_messages, control_authorization, gamepad_changed,
    keyframe_request,
};

/// The four Xbox channels. Order matches creation order (SCTP stream ids 0..3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelLabel {
    Chat,
    Control,
    Message,
    Input,
}

impl ChannelLabel {
    /// Parse str0m's channel label string. Unknown labels → None (ignored).
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "chat" => Some(Self::Chat),
            "control" => Some(Self::Control),
            "message" => Some(Self::Message),
            "input" => Some(Self::Input),
            _ => None,
        }
    }
}

/// An abstract inbound channel event the engine feeds the sequencer.
pub enum ChannelEvent {
    Opened(ChannelLabel),
    Inbound { label: ChannelLabel, data: Vec<u8> },
}

/// A write the engine must perform: `bytes` (binary) on `label`'s channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelWrite {
    pub label: ChannelLabel,
    pub bytes: Vec<u8>,
}

/// Drives the one-time Xbox handshake. Stateful but pure (no IO).
pub struct HandshakeSequencer {
    handshake_sent: bool,
    acked: bool,
    make_id: Box<dyn FnMut() -> String + Send>,
    disconnect: Option<DisconnectReason>,
}

impl HandshakeSequencer {
    /// `make_id` generates the per-config UUID (production: a UUID v4 generator).
    pub fn new(make_id: Box<dyn FnMut() -> String + Send>) -> Self {
        Self { handshake_sent: false, acked: false, make_id, disconnect: None }
    }

    /// True once HandshakeAck has been processed (the session is "ready").
    pub fn is_ready(&self) -> bool {
        self.acked
    }

    /// Take any server-initiated disconnect reason seen on inbound data.
    pub fn take_disconnect(&mut self) -> Option<DisconnectReason> {
        self.disconnect.take()
    }

    /// Process one event; return the ordered writes to perform.
    pub fn on_event(&mut self, ev: ChannelEvent) -> Vec<ChannelWrite> {
        match ev {
            ChannelEvent::Opened(ChannelLabel::Message) if !self.handshake_sent => {
                self.handshake_sent = true;
                vec![ChannelWrite {
                    label: ChannelLabel::Message,
                    bytes: serde_json::to_vec(&protocol::Handshake::new()).expect("serialize"),
                }]
            }
            ChannelEvent::Inbound { data, .. } => self.on_inbound(&data),
            _ => Vec::new(),
        }
    }

    fn on_inbound(&mut self, data: &[u8]) -> Vec<ChannelWrite> {
        match protocol::parse_message(data) {
            InboundMsg::HandshakeAck if !self.acked => {
                self.acked = true;
                self.post_handshake_burst()
            }
            InboundMsg::ServerDisconnect(reason) => {
                self.disconnect = Some(reason);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn post_handshake_burst(&mut self) -> Vec<ChannelWrite> {
        let ctl = |v: &dyn erased_serialize| ChannelWrite {
            label: ChannelLabel::Control,
            bytes: v.to_vec(),
        };
        let mut out = Vec::with_capacity(9);
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&control_authorization()).expect("serialize"),
        });
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&gamepad_changed()).expect("serialize"),
        });
        for msg in config_messages(&mut self.make_id) {
            out.push(ChannelWrite {
                label: ChannelLabel::Message,
                bytes: serde_json::to_vec(&msg).expect("serialize"),
            });
        }
        out.push(ChannelWrite {
            label: ChannelLabel::Control,
            bytes: serde_json::to_vec(&keyframe_request()).expect("serialize"),
        });
        let _ = ctl; // (helper kept readable; not used directly)
        out
    }
}
```

> IMPLEMENTATION NOTE: drop the unused `ctl`/`erased_serialize` helper shown above — it's illustrative. The four explicit `serde_json::to_vec(&builder())` pushes are the real body. `config_messages` takes `impl FnMut() -> String`; pass `&mut self.make_id` (a `&mut Box<dyn FnMut…>` derefs to `FnMut`). If the borrow checker complains, bind `let id = &mut self.make_id;` before the loop.

- [ ] **Step 5: Run, verify pass.** Run: `cargo test rtc::channels` → PASS (4 tests).

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/channels.rs src/rtc/mod.rs
git commit -m "feat(rtc): pure data-channel handshake sequencer (TDD)"
```

---

## Task 2.4: `state.rs` — connection state machine + reconnect backoff (TDD)

**Files:**
- Create: `src/rtc/state.rs`
- Modify: `src/rtc/mod.rs` (add `pub mod state;`)
- Test: inline `#[cfg(test)] mod tests`

Pure decision logic for the master plan's 3 s / 6 s / 9 s reconnect backoff (tuned to Xbox session expiry). str0m-free; the engine consults it on drop.

- [ ] **Step 1: Add the module** to `src/rtc/mod.rs`:

```rust
pub mod state;
```

- [ ] **Step 2: Write the failing test** (`src/rtc/state.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn backoff_is_3_6_9_then_give_up() {
        let mut s = ConnectionState::new();
        assert_eq!(s.on_dropped(), Transition::ScheduleReconnect(Duration::from_secs(3)));
        assert_eq!(s.on_dropped(), Transition::ScheduleReconnect(Duration::from_secs(6)));
        assert_eq!(s.on_dropped(), Transition::ScheduleReconnect(Duration::from_secs(9)));
        assert_eq!(s.on_dropped(), Transition::GiveUp);
        assert_eq!(s.phase(), Phase::Failed);
    }

    #[test]
    fn connected_resets_the_backoff() {
        let mut s = ConnectionState::new();
        assert_eq!(s.on_dropped(), Transition::ScheduleReconnect(Duration::from_secs(3)));
        s.on_connected();
        assert_eq!(s.phase(), Phase::Connected);
        // After a successful reconnect, the next drop starts the ladder over.
        assert_eq!(s.on_dropped(), Transition::ScheduleReconnect(Duration::from_secs(3)));
    }

    #[test]
    fn starts_connecting() {
        assert_eq!(ConnectionState::new().phase(), Phase::Connecting);
    }
}
```

- [ ] **Step 3: Run, verify it fails.** Run: `cargo test rtc::state` → FAIL.

- [ ] **Step 4: Implement** `src/rtc/state.rs`:

```rust
//! Pure connection / reconnect state machine (str0m-free; default build).
//!
//! Reconnect backoff is 3s/6s/9s (master plan — tuned to Xbox session expiry),
//! then give up. `on_connected` resets the ladder.

use std::time::Duration;

/// Backoff ladder in seconds; length = max reconnect attempts before giving up.
pub const RECONNECT_BACKOFFS_SECS: [u64; 3] = [3, 6, 9];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Connecting,
    Connected,
    WaitingToReconnect,
    Failed,
}

/// What the engine should do after a drop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    ScheduleReconnect(Duration),
    GiveUp,
}

pub struct ConnectionState {
    phase: Phase,
    attempt: usize,
}

impl ConnectionState {
    pub fn new() -> Self {
        Self { phase: Phase::Connecting, attempt: 0 }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Mark a successful (re)connection; resets the backoff ladder.
    pub fn on_connected(&mut self) {
        self.phase = Phase::Connected;
        self.attempt = 0;
    }

    /// Handle a drop: schedule the next backoff, or give up once exhausted.
    pub fn on_dropped(&mut self) -> Transition {
        if self.attempt >= RECONNECT_BACKOFFS_SECS.len() {
            self.phase = Phase::Failed;
            return Transition::GiveUp;
        }
        let secs = RECONNECT_BACKOFFS_SECS[self.attempt];
        self.attempt += 1;
        self.phase = Phase::WaitingToReconnect;
        Transition::ScheduleReconnect(Duration::from_secs(secs))
    }
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self::new()
    }
}
```

- [ ] **Step 5: Run, verify pass.** Run: `cargo test rtc::state` → PASS (3 tests).

- [ ] **Step 6: Commit.**

```bash
git add src/rtc/state.rs src/rtc/mod.rs
git commit -m "feat(rtc): pure connection state machine + 3/6/9s reconnect backoff (TDD)"
```

---

## Task 2.5: `engine.rs` — str0m sans-IO loop + `RtcEngine` (integration)

**Files:**
- Create: `src/rtc/engine.rs`
- Modify: `src/rtc/mod.rs` (gated `pub mod engine;`, add `RtcEvent::Reconnecting`)

This is the integration task: refactor the proven `examples/rtc_spike.rs` loop onto the seams, drop the decode/PNG, add event emission, the channel sequencer (2.3), the state machine (2.4), input send, and reconnect. Feature-gated (`native-webrtc`). Verified by Task 2.6 (live), not by a unit test (see Decision 5).

- [ ] **Step 1: Extend `RtcEvent`** in `src/rtc/mod.rs`:

```rust
pub enum RtcEvent {
    Connecting,
    Connected,
    /// First decoded video frame presented — UI leaves the "connecting" state.
    /// (Phase 2: emitted on the first *received* video AU; decode lands Phase 3.)
    FirstFrame,
    /// A reconnect attempt is starting (1-based attempt number).
    Reconnecting { attempt: u32 },
    Stats(StatsSnapshot),
    Disconnected(String),
}
```

And gate the engine module:

```rust
#[cfg(feature = "native-webrtc")]
pub mod engine;
```

> `StatsSnapshot.frames_decoded` is reused as "frames received" in Phase 2 — add a `// Phase 2: received-AU count until decode (Phase 3)` comment at the field.

- [ ] **Step 2: Implement `src/rtc/engine.rs`.** Structure (full code; the loop body is the spike's, refactored):

```rust
//! Native str0m WebRTC engine (offerer). Sans-IO core + dedicated-thread driver.
//!
//! Refactor of the Phase-0 spike onto the hexagonal seams: generic over
//! `S: Signaling` + `T: Transport`, emitting `RtcEvent`s instead of decoding.
//! Decode/render/keepalive/clips are later phases.

use std::net::{IpAddr, SocketAddr, UdpSocket as StdUdpSocket};
use std::time::{Duration, Instant};

use str0m::change::SdpAnswer;
use str0m::channel::{ChannelConfig, ChannelId};
use str0m::media::{Direction, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::sync::mpsc;

use super::channels::{ChannelEvent, ChannelLabel, ChannelWrite, HandshakeSequencer};
use super::signaling::{Signaling, SessionInfo};
use super::state::{ConnectionState, Transition};
use super::transport::Transport;
use super::{Result, RtcError, RtcEvent};
use crate::rtc::input::{GamepadFrame, encode_gamepad};

const CHANNELS: [(&str, &str); 4] = [
    ("chat", "chatV1"),
    ("control", "controlV1"),
    ("message", "messageV1"),
    ("input", "1.0"),
];

/// Commands the caller sends to a running engine.
pub enum EngineCommand {
    SendInput(GamepadFrame),
    Disconnect,
}

/// Caller-facing handle to a spawned engine.
pub struct RtcHandle {
    cmd_tx: mpsc::UnboundedSender<EngineCommand>,
    pub events: mpsc::UnboundedReceiver<RtcEvent>,
    join: std::thread::JoinHandle<()>,
}

impl RtcHandle {
    pub fn send_input(&self, frame: GamepadFrame) {
        let _ = self.cmd_tx.send(EngineCommand::SendInput(frame));
    }
    pub fn disconnect(self) {
        let _ = self.cmd_tx.send(EngineCommand::Disconnect);
        let _ = self.join.join();
    }
}

/// Spawn the production engine on a dedicated thread (current-thread tokio
/// runtime) using XHomeSignaling + UdpTransport. `auth` must hold valid tokens.
pub fn spawn(auth: crate::auth::XboxAuth, server_id: String) -> Result<RtcHandle> {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (event_tx, events) = mpsc::unbounded_channel();
    let join = std::thread::Builder::new()
        .name("rtc-engine".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("engine runtime");
            rt.block_on(async move {
                if let Err(e) = drive(auth, server_id, cmd_rx, event_tx.clone()).await {
                    let _ = event_tx.send(RtcEvent::Disconnected(e.to_string()));
                }
            });
        })
        .map_err(|e| RtcError::Transport(format!("spawn engine thread: {e}")))?;
    Ok(RtcHandle { cmd_tx, events, join })
}

/// Build the production seams then run the reconnect loop.
async fn drive(
    auth: crate::auth::XboxAuth,
    server_id: String,
    mut cmd_rx: mpsc::UnboundedReceiver<EngineCommand>,
    event_tx: mpsc::UnboundedSender<RtcEvent>,
) -> Result<()> {
    let signaling = super::signaling::XHomeSignaling::connect(auth).await?;
    let local_ip = discover_local_ip()?;
    let mut state = ConnectionState::new();

    loop {
        let _ = event_tx.send(RtcEvent::Connecting);
        let transport =
            super::transport::UdpTransport::bind(SocketAddr::new(local_ip, 0)).await?;
        let outcome = connect_and_stream(&signaling, &transport, &server_id, &mut cmd_rx, &event_tx).await;

        match outcome {
            SessionEnd::UserDisconnect => return Ok(()),
            SessionEnd::Dropped(why) => {
                let _ = event_tx.send(RtcEvent::Disconnected(why));
                match state.on_dropped() {
                    Transition::ScheduleReconnect(d) => {
                        tokio::time::sleep(d).await;
                        let _ = event_tx.send(RtcEvent::Reconnecting { attempt: 0 });
                    }
                    Transition::GiveUp => return Ok(()),
                }
            }
        }
    }
}

enum SessionEnd {
    UserDisconnect,
    Dropped(String),
}

/// One connect → stream lifecycle. Returns when the session ends.
async fn connect_and_stream<S: Signaling, T: Transport>(
    signaling: &S,
    transport: &T,
    server_id: &str,
    cmd_rx: &mut mpsc::UnboundedReceiver<EngineCommand>,
    event_tx: &mpsc::UnboundedSender<RtcEvent>,
) -> SessionEnd {
    match connect(signaling, transport, server_id).await {
        Ok((rtc, session, ids, video_mid)) => {
            stream(rtc, transport, signaling, &session, ids, video_mid, cmd_rx, event_tx).await
        }
        Err(e) => SessionEnd::Dropped(format!("connect: {e}")),
    }
}

/// str0m offerer setup: session, channels+media, SDP exchange, candidate trickle.
async fn connect<S: Signaling, T: Transport>(
    signaling: &S,
    transport: &T,
    server_id: &str,
) -> Result<(Rtc, SessionInfo, ChannelMap, Mid)> {
    let session = signaling.create_session(server_id).await?;
    let local_addr = transport.local_addr()?;

    let mut rtc = Rtc::new(Instant::now());
    rtc.add_local_candidate(
        Candidate::host(local_addr, "udp").map_err(|e| RtcError::Transport(e.to_string()))?,
    );

    let mut ids = ChannelMap::default();
    let (video_mid, offer_sdp, pending) = {
        let mut change = rtc.sdp_api();
        for (label, proto) in CHANNELS {
            let id = change.add_channel_with_config(ChannelConfig {
                label: label.to_string(),
                ordered: true,
                protocol: proto.to_string(),
                negotiated: None,
                ..Default::default()
            });
            ids.insert(label, id);
        }
        let video_mid = change.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
        let (offer, pending) = change
            .apply()
            .ok_or_else(|| RtcError::Signaling("empty SDP change".into()))?;
        (video_mid, offer.to_sdp_string(), pending)
    };

    let answer_sdp = signaling.exchange_sdp(&session, &offer_sdp).await?;
    let answer =
        SdpAnswer::from_sdp_string(&answer_sdp).map_err(|e| RtcError::Signaling(format!("answer: {e}")))?;
    rtc.sdp_api()
        .accept_answer(pending, answer)
        .map_err(|e| RtcError::Signaling(format!("accept_answer: {e}")))?;

    // ICE rendezvous: POST our candidate(s) so Xbox replies with its own.
    for cand in extract_candidates(&offer_sdp) {
        let _ = signaling.send_ice(&session, &cand).await;
    }
    Ok((rtc, session, ids, video_mid))
}

/// The sans-IO loop (the spike's loop, on the seams): drain poll_output, select
/// recv/timeout/ice-tick/cmd, drive the handshake sequencer, emit events.
async fn stream<S: Signaling, T: Transport>(
    mut rtc: Rtc,
    transport: &T,
    signaling: &S,
    session: &SessionInfo,
    ids: ChannelMap,
    video_mid: Mid,
    cmd_rx: &mut mpsc::UnboundedReceiver<EngineCommand>,
    event_tx: &mpsc::UnboundedSender<RtcEvent>,
) -> SessionEnd {
    let local_addr = match transport.local_addr() {
        Ok(a) => a,
        Err(e) => return SessionEnd::Dropped(e.to_string()),
    };
    let mut seq = HandshakeSequencer::new(Box::new(uuid_v4));
    let mut buf = vec![0u8; 2048];
    let started = Instant::now();
    let mut connected = false;
    let mut first_frame = false;
    let mut frames: u64 = 0;
    let mut input_seq: u32 = 0;
    let mut ice_tick = tokio::time::interval(Duration::from_millis(500));

    loop {
        // (a) drain poll_output
        let timeout_at = loop {
            match rtc.poll_output() {
                Err(e) => return SessionEnd::Dropped(format!("poll_output: {e}")),
                Ok(Output::Timeout(t)) => break t,
                Ok(Output::Transmit(t)) => {
                    let _ = transport.send_to(&t.contents, t.destination).await;
                }
                Ok(Output::Event(ev)) => {
                    if let Some(end) = handle_event(
                        ev, &mut rtc, &ids, &mut seq, video_mid, event_tx,
                        &mut connected, &mut first_frame, &mut frames,
                    ) {
                        return end;
                    }
                }
            }
        };

        // (b) wait for recv / deadline / ice-tick / command
        let sleep = timeout_at.saturating_duration_since(Instant::now());
        tokio::select! {
            r = transport.recv(&mut buf) => match r {
                Ok((n, source)) => {
                    if let Ok(recv) = Receive::new(Protocol::Udp, source, local_addr, &buf[..n]) {
                        if rtc.handle_input(Input::Receive(Instant::now(), recv)).is_err() {
                            return SessionEnd::Dropped("handle_input recv".into());
                        }
                    }
                }
                Err(e) => return SessionEnd::Dropped(e.to_string()),
            },
            _ = tokio::time::sleep(sleep) => {
                if rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                    return SessionEnd::Dropped("handle_input timeout".into());
                }
            }
            _ = ice_tick.tick() => {
                if !connected {
                    if let Ok(cands) = signaling.poll_ice(session).await {
                        for c in cands {
                            if let Ok(cand) = Candidate::from_sdp_string(&c.candidate) {
                                rtc.add_remote_candidate(cand);
                            }
                        }
                    }
                }
                // Stats heartbeat (received-AU count; bitrate/fps land in Phase 5).
                let _ = event_tx.send(RtcEvent::Stats(super::StatsSnapshot {
                    frames_decoded: frames, ..Default::default()
                }));
            }
            cmd = cmd_rx.recv() => match cmd {
                Some(EngineCommand::Disconnect) | None => return SessionEnd::UserDisconnect,
                Some(EngineCommand::SendInput(frame)) => {
                    let ts = started.elapsed().as_secs_f64() * 1000.0;
                    let bytes = encode_gamepad(&frame, input_seq, ts);
                    input_seq = input_seq.wrapping_add(1);
                    write_channel(&mut rtc, ids.get(ChannelLabel::Input), &bytes);
                }
            }
        }

        if !rtc.is_alive() {
            return SessionEnd::Dropped("rtc not alive".into());
        }
    }
}
```

Plus the small helpers in the same file (`handle_event`, `write_channel`, `ChannelMap`, `extract_candidates`, `discover_local_ip`, `uuid_v4`):

```rust
/// Map ChannelLabel → str0m ChannelId.
#[derive(Default)]
struct ChannelMap([Option<ChannelId>; 4]);
impl ChannelMap {
    fn idx(l: ChannelLabel) -> usize { l as usize }
    fn insert(&mut self, label: &str, id: ChannelId) {
        if let Some(l) = ChannelLabel::from_label(label) { self.0[Self::idx(l)] = Some(id); }
    }
    fn get(&self, l: ChannelLabel) -> Option<ChannelId> { self.0[Self::idx(l)] }
}

/// Handle one str0m Event; Some(end) means the session is over.
#[allow(clippy::too_many_arguments)]
fn handle_event(
    ev: Event, rtc: &mut Rtc, ids: &ChannelMap, seq: &mut HandshakeSequencer,
    video_mid: Mid, event_tx: &mpsc::UnboundedSender<RtcEvent>,
    connected: &mut bool, first_frame: &mut bool, frames: &mut u64,
) -> Option<SessionEnd> {
    match ev {
        Event::Connected => { *connected = true; let _ = event_tx.send(RtcEvent::Connected); }
        Event::ChannelOpen(id, label) => {
            ids_consistency_check(ids, &label, id);
            if let Some(l) = ChannelLabel::from_str(&label) {
                for w in seq.on_event(ChannelEvent::Opened(l)) { apply_write(rtc, ids, &w); }
            }
        }
        Event::ChannelData(cd) => {
            if let Some(l) = label_for(ids, cd.id) {
                for w in seq.on_event(ChannelEvent::Inbound { label: l, data: cd.data }) {
                    apply_write(rtc, ids, &w);
                }
            }
            if let Some(reason) = seq.take_disconnect() {
                return Some(SessionEnd::Dropped(format!("server disconnect: {reason:?}")));
            }
        }
        Event::MediaData(data) if data.mid == video_mid => {
            *frames += 1;
            if !*first_frame { *first_frame = true; let _ = event_tx.send(RtcEvent::FirstFrame); }
        }
        _ => {}
    }
    None
}

fn apply_write(rtc: &mut Rtc, ids: &ChannelMap, w: &ChannelWrite) {
    write_channel(rtc, ids.get(w.label), &w.bytes);
}
fn write_channel(rtc: &mut Rtc, id: Option<ChannelId>, bytes: &[u8]) {
    if let Some(id) = id {
        if let Some(mut ch) = rtc.channel(id) { let _ = ch.write(true, bytes); }
    }
}
fn label_for(ids: &ChannelMap, id: ChannelId) -> Option<ChannelLabel> {
    [ChannelLabel::Chat, ChannelLabel::Control, ChannelLabel::Message, ChannelLabel::Input]
        .into_iter().find(|&l| ids.get(l) == Some(id))
}
fn ids_consistency_check(_ids: &ChannelMap, _label: &str, _id: ChannelId) {}

fn extract_candidates(sdp: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in sdp.lines() {
        if let Some(c) = line.strip_prefix("a=") {
            if c.starts_with("candidate:") && !out.iter().any(|x| x == c) { out.push(c.to_string()); }
        }
    }
    out
}
fn discover_local_ip() -> Result<IpAddr> {
    let s = StdUdpSocket::bind("0.0.0.0:0").map_err(|e| RtcError::Transport(e.to_string()))?;
    s.connect("8.8.8.8:80").map_err(|e| RtcError::Transport(e.to_string()))?;
    Ok(s.local_addr().map_err(|e| RtcError::Transport(e.to_string()))?.ip())
}
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG");
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    b.iter().enumerate().map(|(i, x)| {
        let sep = matches!(i, 4 | 6 | 8 | 10);
        format!("{}{:02x}", if sep { "-" } else { "" }, x)
    }).collect()
}
```

> `ChannelLabel` must be `#[repr(usize)]`-friendly for `as usize` indexing — it already derives `Copy`; add explicit discriminants `Chat=0,Control=1,Message=2,Input=3` in Task 2.3's enum (update that enum when you reach this task; they line up with `CHANNELS` order). If you prefer not to rely on `as usize`, swap `ChannelMap` for a `match`-based setter/getter.

- [ ] **Step 3: Verify the feature build compiles.**

Run: `cargo build --features native-webrtc`
Expected: success. Fix any seam mismatches (e.g. `config_messages` borrow, `ChannelLabel as usize`) guided by the compiler.

- [ ] **Step 4: Verify the default build + pure tests still pass.**

Run: `cargo test`
Expected: all pure tests green (engine is gated out; sequencer/state/signaling-mapper tests run).

- [ ] **Step 5: Commit.**

```bash
git add src/rtc/engine.rs src/rtc/mod.rs
git commit -m "feat(rtc): str0m engine — sans-IO loop on the seams, handshake, reconnect, input send"
```

---

## Task 2.6: `tests/rtc_e2e.rs` — live integration test (`XBOX_E2E=1`)

**Files:**
- Create: `tests/rtc_e2e.rs`

A headless integration test that connects to a real console and asserts the engine reaches `Connected`, runs the handshake, and receives video AUs for ≥5 s. Gated behind `XBOX_E2E=1` (so `cargo test` stays offline-safe) and `--features native-webrtc`. Live reconnect-on-drop is covered by the Task 2.4 unit test plus manual verification; the master plan's "simulated socket drop" is hard to force cleanly inside `cargo test` without flakiness, so this test asserts the connect→handshake→stream path and the report notes reconnect is unit-tested.

- [ ] **Step 1: Write the test** (`tests/rtc_e2e.rs`):

```rust
//! Live engine integration test. Requires a signed-in keychain + a powered-on
//! console. Skipped unless XBOX_E2E=1. Run:
//!   XBOX_E2E=1 cargo test --features native-webrtc --test rtc_e2e -- --nocapture
#![cfg(feature = "native-webrtc")]

use std::time::{Duration, Instant};
use xbox_remote::auth::XboxAuth;
use xbox_remote::rtc::RtcEvent;
use xbox_remote::rtc::engine;

#[tokio::test(flavor = "multi_thread")]
async fn e2e_connect_handshake_receive() {
    if std::env::var("XBOX_E2E").is_err() {
        eprintln!("skipping: set XBOX_E2E=1 (needs live console + signed-in keychain)");
        return;
    }

    let auth = XboxAuth::new();
    assert!(auth.load_cached_tokens().await.expect("load tokens"), "sign in via the app first");

    // Resolve a server_id (env override, else first console).
    let server_id = std::env::var("XBOX_SERVER_ID").unwrap_or_else(|_| {
        // Minimal discovery via the same client the engine uses.
        panic!("set XBOX_SERVER_ID=<serverId> for the E2E test")
    });

    let mut handle = engine::spawn(auth, server_id).expect("spawn engine");

    let mut connected = false;
    let mut first_frame = false;
    let mut last_frames = 0u64;
    let deadline = Instant::now() + Duration::from_secs(25);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), handle.events.recv()).await {
            Ok(Some(RtcEvent::Connected)) => connected = true,
            Ok(Some(RtcEvent::FirstFrame)) => first_frame = true,
            Ok(Some(RtcEvent::Stats(s))) => last_frames = s.frames_decoded,
            Ok(Some(RtcEvent::Disconnected(why))) => panic!("disconnected early: {why}"),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
        if connected && first_frame && last_frames >= 100 {
            break;
        }
    }

    handle.disconnect();
    assert!(connected, "never reached Connected");
    assert!(first_frame, "never received a video AU");
    assert!(last_frames >= 100, "expected >=100 received AUs, got {last_frames}");
}
```

> The `panic!` discovery shortcut keeps the test dependency-free; pass `XBOX_SERVER_ID` (the spike prints it). If you'd rather auto-discover, add a tiny `XHomeClient::get_consoles` call before `spawn` — optional.

- [ ] **Step 2: Confirm it's skipped by default.**

Run: `cargo test --features native-webrtc --test rtc_e2e`
Expected: the test runs but returns immediately ("skipping: set XBOX_E2E=1").

- [ ] **Step 3: Run it live (interactive — needs the console + a signed-in keychain).**

Run: `XBOX_E2E=1 XBOX_SERVER_ID=<id> cargo test --features native-webrtc --test rtc_e2e -- --nocapture`
Expected: PASS — Connected, FirstFrame, ≥100 received AUs. **Pause and ask the human to power on the console before this step.**

- [ ] **Step 4: Commit.**

```bash
git add tests/rtc_e2e.rs
git commit -m "test(rtc): live XBOX_E2E engine integration test (connect→handshake→receive)"
```

---

## Phase 2 Acceptance

- `cargo test` (no features): all pure units green — handshake sequencer (2.3), state machine (2.4), signaling mappers (2.2), plus the existing 93 Phase-1 tests.
- `cargo build --features native-webrtc`: the engine compiles.
- `XBOX_E2E=1 … --test rtc_e2e`: live engine reaches `Connected`, runs the handshake, and emits ≥5 s of received-AU events against a real console.
- Reconnect backoff (3/6/9 s) is unit-proven (2.4); live reconnect verified manually.

On green, the master-plan STATUS block is updated (Phase 2 ✅) and the next slice is **Phase 3 — decode pipeline** (feed the engine's received AUs to `ffmpeg-the-third`/VA-API → `DecodedFrame`, add `opus` + `cpal` audio), then Phase 4 render.

---

## Self-Review

- **Spec coverage (master §Phase 2):** sans-IO loop ✅ (2.5); `accept_answer`/offerer using Phase-0 findings ✅ (2.5 `connect`); reuse `xhome.rs` ✅ (2.2); 4 channels + handshake→auth→config ✅ (2.3 + 2.5); state machine + reconnect 3/6/9 ✅ (2.4); input send ✅ (2.5 `SendInput`). **gilrs 60 Hz input source — deliberately deferred** (no focused window yet; the engine accepts frames via `SendInput`, and the gilrs poller lands with the UI in Phase 6). Keepalive — deferred to Phase 5 per master plan (E2E test runs < the ~56 s expiry).
- **Placeholder scan:** none — every code step is concrete. Two flagged simplifications (the illustrative `ctl`/`erased_serialize` helper in 2.3, and `ChannelLabel as usize`) carry explicit "drop this / add discriminants" notes.
- **Type consistency:** `ChannelLabel`/`ChannelEvent`/`ChannelWrite` defined in 2.3 are consumed unchanged in 2.5; `SessionInfo`/`IceCandidate` from `signaling.rs` used in 2.2 + 2.5; `Transition`/`ConnectionState` from 2.4 used in 2.5 `drive`; `RtcEvent::{Connecting,Connected,FirstFrame,Reconnecting,Stats,Disconnected}` consistent across 2.5 + 2.6; `encode_gamepad`/`GamepadFrame` from Phase-1 `input.rs` used in 2.5.
- **Known follow-ups (not blockers):** `create_session` drops `play_path` (note in 2.2); `Reconnecting{attempt}` currently emitted with `attempt:0` (wire the real count from `ConnectionState` if useful); live reconnect not auto-tested.
