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
    assert!(
        auth.load_cached_tokens().await.expect("load tokens"),
        "sign in via the app first"
    );

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
    assert!(
        last_frames >= 100,
        "expected >=100 received AUs, got {last_frames}"
    );
}
