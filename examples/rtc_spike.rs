//! Phase-0 de-risk spike (THROWAWAY — deleted at the end of Phase 0).
//!
//! Proves the make-or-break unknowns for the native Rust WebRTC engine on Linux:
//!   1. str0m (as the **offerer**) negotiates with Xbox xHome over DTLS-SRTP,
//!      connects ICE, opens the four DCEP data channels, and runs the Xbox
//!      handshake (handshake → control-auth → config) that starts the encoder.
//!   2. The received H.264 access units decode to a real picture of the dashboard.
//!
//! Reuses production signaling (`xbox_remote::xhome`), auth (`xbox_remote::auth`)
//! and the Phase-1 protocol builders (`xbox_remote::rtc::protocol`) verbatim —
//! the point of the lib+bin split.
//!
//! Run (sign in via the app first so tokens are in the OS keychain):
//!
//! ```bash
//! XBOX_DUMP_SDP=1 cargo run --example rtc_spike --features native-webrtc
//! # optional: XBOX_SERVER_ID=<serverId> to pick a specific console
//! ```
//!
//! Acceptance: ≥100 video frames in 5 s, and `/tmp/xbox_frame.png` shows the
//! Xbox dashboard.

use std::net::{IpAddr, SocketAddr, UdpSocket as StdUdpSocket};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow, bail};
use ffmpeg_the_third as ffmpeg;
use str0m::change::SdpAnswer;
use str0m::channel::{ChannelConfig, ChannelId};
use str0m::media::{Direction, MediaKind, Mid};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::UdpSocket;

use xbox_remote::auth::XboxAuth;
use xbox_remote::rtc::protocol::{
    self, InboundMsg, config_messages, control_authorization, gamepad_changed, keyframe_request,
};
use xbox_remote::xhome::{XHomeClient, XHomeConsole};

const SPIKE_DEADLINE: Duration = Duration::from_secs(30);
const TARGET_VIDEO_FRAMES: usize = 100;
const FRAME_WINDOW: Duration = Duration::from_secs(5);
const FRAME_PNG_PATH: &str = "/tmp/xbox_frame.png";

/// The four Xbox data channels, in creation order (matches the browser so SCTP
/// stream IDs line up). label / DCEP subprotocol.
const CHANNELS: [(&str, &str); 4] = [
    ("chat", "chatV1"),
    ("control", "controlV1"),
    ("message", "messageV1"),
    ("input", "1.0"),
];

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,xbox_remote=info".into()),
        )
        .with_target(true)
        .init();

    println!("== Phase-0 str0m receive→decode spike ==");

    // --- 1. Auth (from the OS keychain; sign in via the app first) ----------
    let auth = XboxAuth::new();
    if !auth
        .load_cached_tokens()
        .await
        .context("loading cached tokens")?
    {
        bail!(
            "No valid cached tokens. Launch the app, sign in, then re-run the spike \
             (tokens live in the OS keychain)."
        );
    }
    println!("✔ auth: loaded cached XSTS tokens");

    // --- 2. xHome login + console pick --------------------------------------
    let mut client = XHomeClient::new(auth);
    client.login().await.context("xHome login")?;
    let consoles = client.get_consoles().await.context("listing consoles")?;
    if consoles.is_empty() {
        bail!("No consoles on this account.");
    }
    let console = pick_console(&consoles)?;
    println!(
        "→ using: {} (serverId={}, power={})",
        console.device_name, console.server_id, console.power_state
    );

    // --- 3. Create the streaming session ------------------------------------
    let cfg = client
        .create_session(&console.server_id, Some(&console.play_path))
        .await
        .context("create_session")?;
    let session_path = cfg.session_path.clone();
    println!("✔ session: {} ({})", cfg.session_id, session_path);

    // --- 4. str0m offerer: bind socket, add channels + media, build offer ---
    let local_ip = discover_local_ip().context("discovering local IP")?;
    let udp = UdpSocket::bind(SocketAddr::new(local_ip, 0))
        .await
        .context("binding UDP socket")?;
    let local_addr = udp.local_addr()?;
    println!("✔ local UDP {local_addr}");

    let mut rtc = Rtc::new(Instant::now()); // default config: H.264 + DTLS-SRTP.
    rtc.add_local_candidate(
        Candidate::host(local_addr, "udp").map_err(|e| anyhow!("host candidate: {e}"))?,
    );

    let mut chan_ids = ChannelIds::default();
    let (video_mid, offer_sdp, pending) = {
        let mut change = rtc.sdp_api();
        // Data channels FIRST (DCEP, in-band) so SCTP is in the offer — Xbox
        // won't stream until the message-channel handshake runs over them.
        for (label, proto) in CHANNELS {
            let id = change.add_channel_with_config(ChannelConfig {
                label: label.to_string(),
                ordered: true,
                protocol: proto.to_string(),
                negotiated: None, // in-band DCEP — Xbox requires this
                ..Default::default()
            });
            chan_ids.set(label, id);
        }
        // Mirror the working browser offer: video recvonly, audio sendrecv.
        let video_mid = change.add_media(MediaKind::Video, Direction::RecvOnly, None, None, None);
        change.add_media(MediaKind::Audio, Direction::SendRecv, None, None, None);
        let (offer, pending) = change
            .apply()
            .ok_or_else(|| anyhow!("sdp_api().apply() produced no change"))?;
        (video_mid, offer.to_sdp_string(), pending)
    };
    println!(
        "✔ offer built ({} bytes, 4 channels + video + audio)",
        offer_sdp.len()
    );

    // --- 5. Exchange SDP (XBOX_DUMP_SDP captures offer+answer here) ----------
    let answer_sdp = client
        .exchange_sdp_offer(&session_path, &offer_sdp)
        .await
        .context("SDP exchange")?;
    let answer =
        SdpAnswer::from_sdp_string(&answer_sdp).map_err(|e| anyhow!("parse answer SDP: {e}"))?;
    rtc.sdp_api()
        .accept_answer(pending, answer)
        .map_err(|e| anyhow!("accept_answer: {e}"))?;
    println!("✔ answer applied; classifying crypto…");
    classify_crypto(&answer_sdp);

    // --- 6. Trickle OUR local candidate(s) to Xbox --------------------------
    // The xHome /ice endpoint is a rendezvous: it only returns Xbox's candidates
    // AFTER the client POSTs its own (mirrors the browser onicecandidate path).
    for cand in extract_candidates(&offer_sdp) {
        println!("→ send local candidate: {cand}");
        if let Err(e) = client.send_ice_candidate(&session_path, &cand).await {
            eprintln!("   send candidate failed: {e}");
        }
    }

    // --- 7. Sans-IO loop: ICE → DTLS → channels → handshake → decode --------
    run_session(
        &mut rtc,
        &udp,
        local_addr,
        &client,
        &session_path,
        video_mid,
        chan_ids,
    )
    .await
}

/// ChannelIds we need to write to during the handshake.
#[derive(Default)]
struct ChannelIds {
    control: Option<ChannelId>,
    message: Option<ChannelId>,
}

impl ChannelIds {
    fn set(&mut self, label: &str, id: ChannelId) {
        match label {
            "control" => self.control = Some(id),
            "message" => self.message = Some(id),
            _ => {}
        }
    }
}

fn pick_console(consoles: &[XHomeConsole]) -> Result<XHomeConsole> {
    if let Ok(id) = std::env::var("XBOX_SERVER_ID") {
        return consoles
            .iter()
            .find(|c| c.server_id == id)
            .cloned()
            .ok_or_else(|| anyhow!("XBOX_SERVER_ID={id} not found in console list"));
    }
    consoles
        .iter()
        .find(|c| !c.power_state.eq_ignore_ascii_case("Off"))
        .or_else(|| consoles.first())
        .cloned()
        .ok_or_else(|| anyhow!("no console to pick"))
}

/// Discover the LAN IP that routes toward the internet (no packets sent).
fn discover_local_ip() -> Result<IpAddr> {
    let s = StdUdpSocket::bind("0.0.0.0:0")?;
    s.connect("8.8.8.8:80")?;
    Ok(s.local_addr()?.ip())
}

/// Extract `candidate:…` strings from an SDP's `a=candidate:` lines (deduped).
fn extract_candidates(sdp: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in sdp.lines() {
        if let Some(cand) = line.strip_prefix("a=") {
            if cand.starts_with("candidate:") && !out.iter().any(|c| c == cand) {
                out.push(cand.to_string());
            }
        }
    }
    out
}

/// Phase-0 Task 0.1: classify the answer SDP's SRTP keying mode.
fn classify_crypto(answer_sdp: &str) {
    let fp = answer_sdp.contains("a=fingerprint:");
    let setup = answer_sdp.contains("a=setup:");
    let crypto = answer_sdp.contains("a=crypto:");
    println!("   crypto: a=fingerprint={fp} a=setup={setup} a=crypto(SDES)={crypto}");
    match (fp || setup, crypto) {
        (true, false) => println!("   ⇒ DTLS-SRTP — GREEN (str0m unmodified)"),
        (_, true) => println!("   ⇒ SDES present — investigate (str0m can't inject external SRTP)"),
        (false, false) => println!("   ⇒ neither marker found — inspect the capture manually"),
    }
}

/// Random UUID v4 for config-message ids (Xbox expects per-message ids).
fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS RNG");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        b[6],
        b[7],
        b[8],
        b[9],
        b[10],
        b[11],
        b[12],
        b[13],
        b[14],
        b[15]
    )
}

/// Write JSON bytes to a data channel as binary (the browser sends bytes too).
fn write_channel(rtc: &mut Rtc, id: Option<ChannelId>, bytes: &[u8], what: &str) {
    let Some(id) = id else {
        eprintln!("   channel for {what} not created");
        return;
    };
    match rtc.channel(id) {
        Some(mut ch) => {
            if let Err(e) = ch.write(true, bytes) {
                eprintln!("   channel write ({what}) failed: {e}");
            }
        }
        None => eprintln!("   channel for {what} not open yet"),
    }
}

fn j(v: &impl serde::Serialize) -> Vec<u8> {
    serde_json::to_vec(v).expect("serialize protocol message")
}

/// Send the post-HandshakeAck burst: control auth + gamepadChanged + 6 configs
/// + an initial keyframe request. Mirrors dataChannels.ts onHandshakeComplete.
fn send_post_handshake(rtc: &mut Rtc, ids: &ChannelIds) {
    write_channel(
        rtc,
        ids.control,
        &j(&control_authorization()),
        "control/auth",
    );
    write_channel(rtc, ids.control, &j(&gamepad_changed()), "control/gamepad");
    for msg in config_messages(uuid_v4) {
        write_channel(rtc, ids.message, &j(&msg), "message/config");
    }
    write_channel(
        rtc,
        ids.control,
        &j(&keyframe_request()),
        "control/keyframe",
    );
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    rtc: &mut Rtc,
    udp: &UdpSocket,
    local_addr: SocketAddr,
    client: &XHomeClient,
    session_path: &str,
    video_mid: Mid,
    ids: ChannelIds,
) -> Result<()> {
    let mut decoder = H264ToPng::new().context("init H264 decoder")?;
    let mut buf = vec![0u8; 2048];

    let started = Instant::now();
    let mut first_video_at: Option<Instant> = None;
    let mut video_frames = 0usize;
    let mut audio_frames = 0usize;
    let mut video_codec = String::from("?");
    let mut connected = false;
    let mut handshake_done = false;
    let mut png_saved = false;
    let mut ice_tick = tokio::time::interval(Duration::from_millis(500));

    loop {
        // (a) Drain poll_output; react to transmits/events (writes here are legal).
        let timeout_at = loop {
            match rtc.poll_output().map_err(|e| anyhow!("poll_output: {e}"))? {
                Output::Timeout(t) => break t,
                Output::Transmit(t) => {
                    let _ = udp.send_to(&t.contents, t.destination).await;
                }
                Output::Event(ev) => match ev {
                    Event::Connected => {
                        connected = true;
                        println!("✔ str0m Connected (ICE+DTLS) @ {:?}", started.elapsed());
                    }
                    Event::IceConnectionStateChange(s) => {
                        println!("   ice: {s:?} @ {:?}", started.elapsed());
                    }
                    Event::ChannelOpen(id, label) => {
                        println!(
                            "   channel OPEN: {label} ({id:?}) @ {:?}",
                            started.elapsed()
                        );
                        if label == "message" {
                            write_channel(
                                rtc,
                                Some(id),
                                &j(&protocol::Handshake::new()),
                                "handshake",
                            );
                            println!("→ sent message-channel Handshake");
                        }
                    }
                    Event::ChannelData(cd) => match protocol::parse_message(&cd.data) {
                        InboundMsg::HandshakeAck if !handshake_done => {
                            handshake_done = true;
                            println!(
                                "✔ HandshakeAck @ {:?} → sending auth/config/keyframe",
                                started.elapsed()
                            );
                            send_post_handshake(rtc, &ids);
                        }
                        InboundMsg::ServerDisconnect(reason) => {
                            println!("✖ server disconnect: {reason:?}");
                        }
                        _ => {}
                    },
                    Event::MediaData(data) => {
                        if data.mid == video_mid {
                            if first_video_at.is_none() {
                                first_video_at = Some(Instant::now());
                                video_codec = format!("{:?}", data.params.spec().codec);
                                println!(
                                    "✔ first VIDEO @ {:?} codec={video_codec} keyframe={}",
                                    started.elapsed(),
                                    data.is_keyframe()
                                );
                            }
                            video_frames += 1;
                            if !png_saved {
                                match decoder.feed(&data.data) {
                                    Ok(true) => {
                                        png_saved = true;
                                        println!(
                                            "✔ decoded first picture → {FRAME_PNG_PATH} @ {:?}",
                                            started.elapsed()
                                        );
                                    }
                                    Ok(false) => {}
                                    Err(e) => eprintln!("   decode warn: {e}"),
                                }
                            }
                        } else {
                            audio_frames += 1;
                        }
                    }
                    _ => {}
                },
            }
        };

        let window_ok = first_video_at
            .map(|t| t.elapsed() >= FRAME_WINDOW)
            .unwrap_or(false);
        if (png_saved && video_frames >= TARGET_VIDEO_FRAMES && window_ok)
            || started.elapsed() >= SPIKE_DEADLINE
        {
            break;
        }

        // (b) Wait for inbound datagram, the str0m deadline, or a 500ms tick.
        let sleep = timeout_at.saturating_duration_since(Instant::now());
        tokio::select! {
            r = udp.recv_from(&mut buf) => {
                let (n, source) = r.context("udp recv")?;
                let recv = Receive::new(Protocol::Udp, source, local_addr, &buf[..n])
                    .map_err(|e| anyhow!("Receive::new: {e}"))?;
                rtc.handle_input(Input::Receive(Instant::now(), recv))
                    .map_err(|e| anyhow!("handle_input(recv): {e}"))?;
            }
            _ = tokio::time::sleep(sleep) => {
                rtc.handle_input(Input::Timeout(Instant::now()))
                    .map_err(|e| anyhow!("handle_input(timeout): {e}"))?;
            }
            _ = ice_tick.tick() => {
                // Trickle remote candidates until connected.
                if !connected {
                    match client.poll_ice_candidates(session_path).await {
                        Ok(cands) => for c in cands {
                            if let Ok(cand) = Candidate::from_sdp_string(&c.candidate) {
                                rtc.add_remote_candidate(cand);
                            }
                        },
                        Err(e) => eprintln!("   ice poll error: {e}"),
                    }
                }
                // Nudge Xbox for a keyframe until the first picture arrives.
                if handshake_done && first_video_at.is_none() {
                    write_channel(rtc, ids.control, &j(&keyframe_request()), "control/keyframe-nudge");
                }
            }
        }

        if !rtc.is_alive() {
            println!("✖ rtc no longer alive @ {:?}", started.elapsed());
            break;
        }
    }

    let fps = first_video_at
        .map(|t| video_frames as f64 / t.elapsed().as_secs_f64().max(0.001))
        .unwrap_or(0.0);
    println!("\n== spike result ==");
    println!("connected:       {connected}");
    println!("handshake:       {handshake_done}");
    println!("video frames:    {video_frames} (codec {video_codec})");
    println!("audio frames:    {audio_frames}");
    println!("approx fps:      {fps:.1}");
    println!("png saved:       {png_saved} ({FRAME_PNG_PATH})");
    let accept = png_saved && video_frames >= TARGET_VIDEO_FRAMES;
    println!("ACCEPTANCE:      {}", if accept { "PASS" } else { "FAIL" });

    if !accept {
        bail!("spike acceptance not met (see report above)");
    }
    Ok(())
}

/// Minimal H.264 (Annex-B) → first-picture-as-PNG decoder on ffmpeg-the-third.
struct H264ToPng {
    decoder: ffmpeg::decoder::Video,
    done: bool,
}

impl H264ToPng {
    fn new() -> Result<Self> {
        ffmpeg::init().context("ffmpeg init")?;
        let codec = ffmpeg::decoder::find(ffmpeg::codec::Id::H264)
            .ok_or_else(|| anyhow!("no H264 decoder in this ffmpeg build"))?;
        let ctx = ffmpeg::codec::context::Context::new_with_codec(codec);
        let decoder = ctx.decoder().video().context("open H264 decoder")?;
        Ok(Self {
            decoder,
            done: false,
        })
    }

    /// Feed one Annex-B access unit. Returns Ok(true) once a PNG has been written.
    fn feed(&mut self, annexb: &[u8]) -> Result<bool> {
        if self.done {
            return Ok(true);
        }
        let packet = ffmpeg::codec::packet::Packet::copy(annexb);
        let _ = self.decoder.send_packet(&packet); // EAGAIN before first keyframe is normal

        let mut frame = ffmpeg::frame::Video::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            save_frame_png(&frame, FRAME_PNG_PATH)?;
            self.done = true;
            return Ok(true);
        }
        Ok(false)
    }
}

/// Scale a decoded YUV frame to RGB24 and write it as a PNG.
fn save_frame_png(frame: &ffmpeg::frame::Video, path: &str) -> Result<()> {
    use ffmpeg::format::Pixel;
    use ffmpeg::software::scaling::{Context as Scaler, Flags};

    let (w, h) = (frame.width(), frame.height());
    let mut scaler = Scaler::get(frame.format(), w, h, Pixel::RGB24, w, h, Flags::BILINEAR)
        .context("build sws scaler")?;
    let mut rgb = ffmpeg::frame::Video::empty();
    scaler.run(frame, &mut rgb).context("sws scale")?;

    // sws output rows are padded to `stride`; pack tightly for the PNG encoder.
    let stride = rgb.stride(0);
    let data = rgb.data(0);
    let (wu, hu) = (w as usize, h as usize);
    let mut packed = Vec::with_capacity(wu * hu * 3);
    for y in 0..hu {
        packed.extend_from_slice(&data[y * stride..y * stride + wu * 3]);
    }
    let img = image::RgbImage::from_raw(w, h, packed)
        .ok_or_else(|| anyhow!("RGB buffer size mismatch"))?;
    img.save(path).context("write PNG")?;
    Ok(())
}
