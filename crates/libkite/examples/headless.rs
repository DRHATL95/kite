//! Headless stream through the C ABI: sign in from the keychain, connect to the first
//! console (or `XBOX_SERVER_ID`), count decoded frames for `KITE_HEADLESS_SECONDS`
//! (default 15), disconnect. Nothing is drawn.
//!
//! Talks to the real console, so it only runs with `XBOX_E2E=1`:
//! `XBOX_E2E=1 cargo run -p libkite --features native-webrtc --example headless`
//! Exit code 0 means frames were decoded.

use std::ffi::{CStr, CString, c_void};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use libkite::{
    KiteEvent, KiteEventKind, KiteStatus, kite_connect, kite_disconnect, kite_free,
    kite_list_consoles, kite_new,
};

static FRAMES: AtomicU64 = AtomicU64::new(0);
static FAILED: AtomicBool = AtomicBool::new(false);
static CONSOLES: Mutex<Option<String>> = Mutex::new(None);

unsafe extern "C" fn on_event(_user: *mut c_void, event: *const KiteEvent) {
    // SAFETY: libkite passes a valid event for the duration of this call.
    let event = unsafe { &*event };
    let text = if event.text.is_null() {
        String::new()
    } else {
        // SAFETY: non-null `text` is NUL-terminated and valid during the callback.
        unsafe { CStr::from_ptr(event.text) }
            .to_string_lossy()
            .into_owned()
    };
    match event.kind {
        KiteEventKind::Consoles => *CONSOLES.lock().unwrap() = Some(text),
        KiteEventKind::Stats => {
            FRAMES.store(event.frames_decoded, Ordering::Relaxed);
            println!(
                "stats: {} fps, {} kbps, {} frames, {} freezes",
                event.fps, event.bitrate_kbps, event.frames_decoded, event.freeze_count
            );
        }
        KiteEventKind::Error => {
            FAILED.store(true, Ordering::Relaxed);
            println!("error: {text}");
        }
        kind => println!("{kind:?} {text}"),
    }
}

/// First `serverId` in the console list JSON, without pulling a JSON crate into the
/// example: the field is a plain identifier string.
fn first_server_id(json: &str) -> Option<String> {
    let rest = json.split_once("\"serverId\":\"")?.1;
    Some(rest.split_once('"')?.0.to_owned())
}

fn main() {
    if std::env::var("XBOX_E2E").as_deref() != Ok("1") {
        println!("skipped: set XBOX_E2E=1 to stream from the real console");
        return;
    }
    let seconds = std::env::var("KITE_HEADLESS_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(15);

    let engine = kite_new(Some(on_event), std::ptr::null_mut());
    assert_ne!(engine, 0, "kite_new failed");

    let server_id = std::env::var("XBOX_SERVER_ID").ok().or_else(|| {
        assert_eq!(kite_list_consoles(engine), KiteStatus::Ok);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline && !FAILED.load(Ordering::Relaxed) {
            if let Some(json) = CONSOLES.lock().unwrap().take() {
                return first_server_id(&json);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    });

    let mut ok = false;
    if let Some(server_id) = server_id {
        let server_id = CString::new(server_id).expect("server id has no NUL");
        // SAFETY: `server_id` is a valid NUL-terminated string for the call.
        let status = unsafe { kite_connect(engine, server_id.as_ptr()) };
        assert_eq!(status, KiteStatus::Ok);
        std::thread::sleep(Duration::from_secs(seconds));
        ok = FRAMES.load(Ordering::Relaxed) > 0;
        println!("disconnect: {:?}", kite_disconnect(engine));
    } else {
        println!("no console to connect to");
    }
    assert_eq!(kite_free(engine), KiteStatus::Ok);
    println!("frames decoded: {}", FRAMES.load(Ordering::Relaxed));
    std::process::exit(if ok { 0 } else { 1 });
}
