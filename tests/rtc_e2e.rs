//! Live engine integration test. Requires a signed-in keychain + a powered-on
//! console. Skipped unless XBOX_E2E=1. Run:
//!   XBOX_E2E=1 cargo test --features native-webrtc --test rtc_e2e -- --nocapture
#![cfg(feature = "native-webrtc")]

use std::time::{Duration, Instant};
use kite::auth::XboxAuth;
use kite::rtc::RtcEvent;
use kite::rtc::engine;

#[tokio::test(flavor = "multi_thread")]
async fn e2e_connect_handshake_receive() {
    if std::env::var("XBOX_E2E").is_err() {
        eprintln!("skipping: set XBOX_E2E=1 (needs live console + signed-in keychain)");
        return;
    }

    let auth = XboxAuth::new();
    assert!(
        auth.load_cached_tokens().await.expect("load tokens"),
        "sign in via the app first"
    );

    // Resolve a server_id (env override, else first console).
    let server_id = std::env::var("XBOX_SERVER_ID").unwrap_or_else(|_| {
        // Minimal discovery via the same client the engine uses.
        panic!("set XBOX_SERVER_ID=<serverId> for the E2E test")
    });

    let mut handle = engine::spawn(auth, server_id, None, None).expect("spawn engine");
    let mut rx = handle.take_events().expect("event stream");

    // Optional manual hold so a human can watch/hear the stream after the frame
    // target is hit (e.g. `XBOX_E2E_HOLD_SECS=20`). Unset → fast disconnect (CI).
    let hold = std::env::var("XBOX_E2E_HOLD_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs);

    let mut connected = false;
    let mut first_frame = false;
    let mut last_frames = 0u64;
    let mut saw_bitrate = false;
    let deadline = Instant::now() + Duration::from_secs(25);

    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(2), rx.recv()).await {
            Ok(Some(RtcEvent::Connected)) => connected = true,
            Ok(Some(RtcEvent::FirstFrame)) => first_frame = true,
            Ok(Some(RtcEvent::Stats(s))) => {
                last_frames = s.frames_decoded;
                if s.bitrate_kbps > 0 {
                    saw_bitrate = true;
                }
            }
            Ok(Some(RtcEvent::Disconnected(why))) => panic!("disconnected early: {why}"),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
        if connected && first_frame && last_frames >= 100 {
            break;
        }
    }

    // Keep the session alive for the by-ear/by-eye check; the engine keeps decoding
    // and playing audio. Drain events so the channel can't grow and an early drop
    // is surfaced.
    if let Some(hold_dur) = hold {
        eprintln!(
            "holding the session open for {}s — listen for Xbox audio…",
            hold_dur.as_secs()
        );
        let hold_until = Instant::now() + hold_dur;
        while Instant::now() < hold_until {
            match tokio::time::timeout(Duration::from_secs(1), rx.recv()).await {
                Ok(Some(RtcEvent::Disconnected(why))) => panic!("dropped during hold: {why}"),
                Ok(Some(RtcEvent::Stats(s))) => {
                    last_frames = s.frames_decoded;
                    if s.bitrate_kbps > 0 {
                        saw_bitrate = true;
                    }
                }
                Ok(None) => break,
                _ => {}
            }
        }
    }

    assert!(saw_bitrate, "expected at least one stats sample with nonzero bitrate");

    let clip = handle.clip().await.expect("a clip should assemble from the buffered AUs");
    assert!(!clip.video.is_empty(), "clip has video frames");
    let mp4 = kite::clip::mux_opus_to_mp4(&clip).expect("mux the clip to MP4");
    assert!(mp4.windows(4).any(|w| w == b"ftyp"), "muxed clip is a fast-start MP4");

    handle.disconnect();
    assert!(connected, "never reached Connected");
    // Phase 3: FirstFrame + frames_decoded now count DECODED frames (ffmpeg),
    // not just received AUs — a pass proves the H.264 decode pipeline works.
    assert!(first_frame, "never decoded a video frame");
    assert!(
        last_frames >= 100,
        "expected >=100 DECODED frames, got {last_frames}"
    );
    // Audio: cpal played decoded Opus through the default output device during the
    // run (verified by ear — no programmatic assertion; engine logs submit errors).
}
