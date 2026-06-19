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
use super::signaling::{SessionInfo, Signaling};
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
    Ok(RtcHandle {
        cmd_tx,
        events,
        join,
    })
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
        // A bind failure is just another reason to (re)connect — route it through
        // the same drop/backoff path rather than aborting the engine with `?`.
        let outcome = match super::transport::UdpTransport::bind(SocketAddr::new(local_ip, 0)).await
        {
            Ok(transport) => {
                connect_and_stream(
                    &signaling,
                    &transport,
                    &server_id,
                    &mut cmd_rx,
                    &event_tx,
                    &mut state,
                )
                .await
            }
            Err(e) => SessionEnd::Dropped(format!("bind: {e}")),
        };

        match outcome {
            SessionEnd::UserDisconnect => return Ok(()),
            SessionEnd::Dropped(why) => {
                let _ = event_tx.send(RtcEvent::Disconnected(why));
                match state.on_dropped() {
                    Transition::ScheduleReconnect(d) => {
                        // Cancellable backoff: a Disconnect during the wait exits
                        // promptly instead of blocking disconnect() for up to 9s.
                        tokio::select! {
                            _ = tokio::time::sleep(d) => {}
                            cmd = cmd_rx.recv() => {
                                if matches!(cmd, Some(EngineCommand::Disconnect) | None) {
                                    return Ok(());
                                }
                            }
                        }
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
#[allow(clippy::too_many_arguments)]
async fn connect_and_stream<S: Signaling, T: Transport>(
    signaling: &S,
    transport: &T,
    server_id: &str,
    cmd_rx: &mut mpsc::UnboundedReceiver<EngineCommand>,
    event_tx: &mpsc::UnboundedSender<RtcEvent>,
    state: &mut ConnectionState,
) -> SessionEnd {
    match connect(signaling, transport, server_id).await {
        Ok((rtc, session, ids, video_mid)) => {
            stream(
                rtc, transport, signaling, &session, ids, video_mid, cmd_rx, event_tx, state,
            )
            .await
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
    let answer = SdpAnswer::from_sdp_string(&answer_sdp)
        .map_err(|e| RtcError::Signaling(format!("answer: {e}")))?;
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
#[allow(clippy::too_many_arguments)]
async fn stream<S: Signaling, T: Transport>(
    mut rtc: Rtc,
    transport: &T,
    signaling: &S,
    session: &SessionInfo,
    ids: ChannelMap,
    video_mid: Mid,
    cmd_rx: &mut mpsc::UnboundedReceiver<EngineCommand>,
    event_tx: &mpsc::UnboundedSender<RtcEvent>,
    state: &mut ConnectionState,
) -> SessionEnd {
    let local_addr = match transport.local_addr() {
        Ok(a) => a,
        Err(e) => return SessionEnd::Dropped(e.to_string()),
    };
    let mut seq = HandshakeSequencer::new(Box::new(uuid_v4));
    // Max UDP payload — a generous ceiling so an inbound datagram is never truncated.
    let mut buf = vec![0u8; 65_535];
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
                        ev,
                        &mut rtc,
                        &ids,
                        &mut seq,
                        video_mid,
                        event_tx,
                        &mut connected,
                        &mut first_frame,
                        &mut frames,
                        state,
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
                    if let Ok(recv) = Receive::new(Protocol::Udp, source, local_addr, &buf[..n])
                        && rtc.handle_input(Input::Receive(Instant::now(), recv)).is_err()
                    {
                        return SessionEnd::Dropped("handle_input recv".into());
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
                if !connected
                    && let Ok(cands) = signaling.poll_ice(session).await
                {
                    for c in cands {
                        if let Ok(cand) = Candidate::from_sdp_string(&c.candidate) {
                            rtc.add_remote_candidate(cand);
                        }
                    }
                }
                // Stats heartbeat (received-AU count; bitrate/fps land in Phase 5).
                let _ = event_tx.send(RtcEvent::Stats(super::StatsSnapshot {
                    frames_decoded: frames,
                    ..Default::default()
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

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Map ChannelLabel → str0m ChannelId (indexed by label discriminant).
#[derive(Default)]
struct ChannelMap([Option<ChannelId>; 4]);

impl ChannelMap {
    fn idx(l: ChannelLabel) -> usize {
        l as usize
    }

    fn insert(&mut self, label: &str, id: ChannelId) {
        if let Some(l) = ChannelLabel::from_label(label) {
            self.0[Self::idx(l)] = Some(id);
        }
    }

    fn get(&self, l: ChannelLabel) -> Option<ChannelId> {
        self.0[Self::idx(l)]
    }
}

/// Handle one str0m Event; `Some(end)` means the session is over.
#[allow(clippy::too_many_arguments)]
fn handle_event(
    ev: Event,
    rtc: &mut Rtc,
    ids: &ChannelMap,
    seq: &mut HandshakeSequencer,
    video_mid: Mid,
    event_tx: &mpsc::UnboundedSender<RtcEvent>,
    connected: &mut bool,
    first_frame: &mut bool,
    frames: &mut u64,
    state: &mut ConnectionState,
) -> Option<SessionEnd> {
    match ev {
        Event::Connected => {
            *connected = true;
            // Reset the reconnect backoff: this session reached DTLS-up, so a later
            // drop should retry from 3s rather than continue climbing the ladder.
            state.on_connected();
            let _ = event_tx.send(RtcEvent::Connected);
        }
        // The 4 channels were registered at offer time (connect()); their str0m ids
        // are already in ChannelMap, so route by label and ignore the event's id.
        Event::ChannelOpen(_id, label) => {
            if let Some(l) = ChannelLabel::from_label(&label) {
                for w in seq.on_event(ChannelEvent::Opened(l)) {
                    apply_write(rtc, ids, &w);
                }
            }
        }
        Event::ChannelData(cd) => {
            if let Some(l) = label_for(ids, cd.id) {
                for w in seq.on_event(ChannelEvent::Inbound {
                    label: l,
                    data: cd.data,
                }) {
                    apply_write(rtc, ids, &w);
                }
            }
            if let Some(reason) = seq.take_disconnect() {
                return Some(SessionEnd::Dropped(format!(
                    "server disconnect: {reason:?}"
                )));
            }
        }
        Event::MediaData(data) if data.mid == video_mid => {
            *frames += 1;
            if !*first_frame {
                *first_frame = true;
                let _ = event_tx.send(RtcEvent::FirstFrame);
            }
        }
        _ => {}
    }
    None
}

fn apply_write(rtc: &mut Rtc, ids: &ChannelMap, w: &ChannelWrite) {
    write_channel(rtc, ids.get(w.label), &w.bytes);
}

fn write_channel(rtc: &mut Rtc, id: Option<ChannelId>, bytes: &[u8]) {
    if let Some(id) = id
        && let Some(mut ch) = rtc.channel(id)
    {
        let _ = ch.write(true, bytes);
    }
}

fn label_for(ids: &ChannelMap, id: ChannelId) -> Option<ChannelLabel> {
    [
        ChannelLabel::Chat,
        ChannelLabel::Control,
        ChannelLabel::Message,
        ChannelLabel::Input,
    ]
    .into_iter()
    .find(|&l| ids.get(l) == Some(id))
}

fn extract_candidates(sdp: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in sdp.lines() {
        if let Some(c) = line.strip_prefix("a=")
            && c.starts_with("candidate:")
            && !out.iter().any(|x| x == c)
        {
            out.push(c.to_string());
        }
    }
    out
}

fn discover_local_ip() -> Result<IpAddr> {
    let s = StdUdpSocket::bind("0.0.0.0:0").map_err(|e| RtcError::Transport(e.to_string()))?;
    s.connect("8.8.8.8:80")
        .map_err(|e| RtcError::Transport(e.to_string()))?;
    Ok(s.local_addr()
        .map_err(|e| RtcError::Transport(e.to_string()))?
        .ip())
}

fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    b.iter()
        .enumerate()
        .map(|(i, x)| {
            let sep = matches!(i, 4 | 6 | 8 | 10);
            format!("{}{:02x}", if sep { "-" } else { "" }, x)
        })
        .collect()
}
