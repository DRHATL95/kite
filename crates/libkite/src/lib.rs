//! libkite: the Kite engine behind a C ABI.
//!
//! Rules of the boundary:
//! - An engine is named by a [`KiteHandle`] number, never a pointer. A stale or
//!   already-freed handle is reported as [`KiteStatus::InvalidHandle`]; it cannot crash.
//! - Every command except [`kite_free`] returns at once. Results arrive later through
//!   the event callback, on a libkite thread: the host marshals them to its UI thread.
//! - [`kite_free`] waits for the stream to close on the console and for libkite's
//!   threads to stop. Once it returns, the callback is never called again.
//! - `KiteEvent.text` is only valid for the duration of the callback.
//!
//! The same rules are repeated in the generated header (see `cbindgen.toml`), because
//! that is the only file a host author reads.
//!
//! Not here yet: drawing video into the host's GL context (waits on the Linux spike),
//! stream options, gamepads, clip. Until gamepads land, a connected session sends
//! neutral input so the console does not drop it as idle.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString, c_char, c_void};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use kite_core::auth::XboxAuth;
use kite_core::xhome::XHomeClient;

#[cfg(any(test, feature = "native-webrtc"))]
mod session;

/// Names one engine. 0 is never a valid handle.
pub type KiteHandle = u64;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KiteStatus {
    Ok = 0,
    /// The handle is 0, was never issued, or was already freed.
    InvalidHandle = 1,
    /// A pointer argument was null or not valid UTF-8.
    InvalidArgument = 2,
    /// There is no session to act on.
    NotConnected = 3,
    /// This build of libkite has no media stack.
    Unsupported = 4,
    /// See `kite_last_error`.
    Failed = 5,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KiteEventKind {
    /// `text` is the URL to open in the user's browser.
    SignInUrl = 1,
    SignedIn = 2,
    SignedOut = 3,
    /// `text` is a JSON array of consoles (serverId, deviceName, consoleType,
    /// powerState, isDevKit, playPath).
    Consoles = 4,
    Connecting = 5,
    Connected = 6,
    FirstFrame = 7,
    /// `attempt` is the 1-based reconnect attempt.
    Reconnecting = 8,
    /// `bitrate_kbps`, `fps`, `frames_decoded` and `freeze_count` are set.
    Stats = 9,
    /// The session ended. `text` is the reason.
    Disconnected = 10,
    /// A command failed. `text` is the message.
    Error = 11,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct KiteEvent {
    pub kind: KiteEventKind,
    /// UTF-8, NUL-terminated, or null. Valid only during the callback.
    pub text: *const c_char,
    pub attempt: u32,
    pub bitrate_kbps: u32,
    pub fps: u32,
    pub freeze_count: u32,
    pub frames_decoded: u64,
}

/// Called on a libkite thread for every event. `user_data` is passed back untouched.
pub type KiteEventCallback =
    Option<unsafe extern "C" fn(user_data: *mut c_void, event: *const KiteEvent)>;

thread_local! {
    /// True while this thread is inside the host's event callback.
    static IN_CALLBACK: Cell<bool> = const { Cell::new(false) };
}

/// Delivers events to the host, and stops for good once closed.
pub(crate) struct Emitter {
    callback: KiteEventCallback,
    user_data: usize,
    /// Held across each callback, so closing waits for one in flight.
    closed: Mutex<bool>,
}

impl Emitter {
    fn emit(&self, kind: KiteEventKind, text: Option<&str>, fill: impl FnOnce(&mut KiteEvent)) {
        let closed = self.closed.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(callback) = self.callback else {
            return;
        };
        if *closed {
            return;
        }
        // Interior NULs cannot be passed through a C string; drop them.
        let text = text.and_then(|t| CString::new(t.replace('\0', "")).ok());
        let mut event = KiteEvent {
            kind,
            text: text.as_ref().map_or(std::ptr::null(), |t| t.as_ptr()),
            attempt: 0,
            bitrate_kbps: 0,
            fps: 0,
            freeze_count: 0,
            frames_decoded: 0,
        };
        fill(&mut event);
        // SAFETY: the host supplied this function pointer and `user_data` together in
        // `kite_new` and keeps both valid until `kite_free` returns; `closed` is held,
        // so `kite_free` has not returned. `event` and `text` outlive the call.
        IN_CALLBACK.set(true);
        unsafe { callback(self.user_data as *mut c_void, &event) };
        IN_CALLBACK.set(false);
    }

    #[cfg(test)]
    pub(crate) fn silent() -> Self {
        Self {
            callback: None,
            user_data: 0,
            closed: Mutex::new(false),
        }
    }

    fn simple(&self, kind: KiteEventKind) {
        self.emit(kind, None, |_| {});
    }

    pub(crate) fn text(&self, kind: KiteEventKind, text: &str) {
        self.emit(kind, Some(text), |_| {});
    }

    fn close(&self) {
        *self.closed.lock().unwrap_or_else(PoisonError::into_inner) = true;
    }

    fn is_closed(&self) -> bool {
        *self.closed.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(feature = "native-webrtc")]
type Sessions = session::Sessions<kite_core::rtc::engine::RtcHandle>;

#[cfg(feature = "native-webrtc")]
impl session::Stream for kite_core::rtc::engine::RtcHandle {
    fn idle_input(&self) {
        self.send_input(kite_core::rtc::input::GamepadFrame::neutral());
    }
    fn stop(self) {
        self.disconnect();
    }
}

struct Engine {
    runtime: Mutex<Option<tokio::runtime::Runtime>>,
    tasks: tokio::runtime::Handle,
    auth: XboxAuth,
    emitter: Arc<Emitter>,
    #[cfg(feature = "native-webrtc")]
    sessions: Sessions,
}

static ENGINES: LazyLock<Mutex<HashMap<KiteHandle, Arc<Engine>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::default());
}

fn fail(message: impl std::fmt::Display) -> KiteStatus {
    let text = CString::new(message.to_string().replace('\0', "")).unwrap_or_default();
    LAST_ERROR.with(|e| *e.borrow_mut() = text);
    KiteStatus::Failed
}

fn engine(handle: KiteHandle) -> Result<Arc<Engine>, KiteStatus> {
    ENGINES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&handle)
        .cloned()
        .ok_or(KiteStatus::InvalidHandle)
}

/// The message for the last failure on this thread (a `KITE_STATUS_FAILED` return, or
/// `kite_new` returning 0). Valid until the next libkite call on this thread. Never null.
#[unsafe(no_mangle)]
pub extern "C" fn kite_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

/// Create an engine. Returns 0 on failure (see `kite_last_error`). `callback` may be
/// null, in which case no events are delivered.
#[unsafe(no_mangle)]
pub extern "C" fn kite_new(callback: KiteEventCallback, user_data: *mut c_void) -> KiteHandle {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("libkite")
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            fail(format!("could not start the libkite runtime: {e}"));
            return 0;
        }
    };
    let emitter = Arc::new(Emitter {
        callback,
        user_data: user_data as usize,
        closed: Mutex::new(false),
    });
    let engine = Engine {
        tasks: runtime.handle().clone(),
        runtime: Mutex::new(Some(runtime)),
        auth: XboxAuth::new(),
        #[cfg(feature = "native-webrtc")]
        sessions: Sessions::new(Arc::clone(&emitter)),
        emitter,
    };
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    ENGINES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(handle, Arc::new(engine));
    handle
}

/// How long `kite_free` waits for libkite's own threads after the stream has closed.
const RUNTIME_SHUTDOWN: Duration = Duration::from_secs(2);

/// Destroy an engine. Waits until the stream is closed on the console and libkite's
/// threads have stopped, which can take several seconds (longer if a connect is still
/// in progress), so do not call it on a thread the event callback waits on. The
/// callback is not called after this returns. Freeing twice returns
/// `KITE_STATUS_INVALID_HANDLE`; calling it from inside the callback is refused with
/// `KITE_STATUS_FAILED`.
#[unsafe(no_mangle)]
pub extern "C" fn kite_free(handle: KiteHandle) -> KiteStatus {
    if IN_CALLBACK.get() {
        return fail("kite_free was called from inside the event callback");
    }
    let removed = ENGINES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&handle);
    let Some(engine) = removed else {
        return KiteStatus::InvalidHandle;
    };
    engine.emitter.close();
    #[cfg(feature = "native-webrtc")]
    engine.sessions.shutdown();
    let runtime = engine
        .runtime
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(runtime) = runtime {
        runtime.shutdown_timeout(RUNTIME_SHUTDOWN);
    }
    KiteStatus::Ok
}

/// Report whether a saved sign-in exists: emits `SignedIn` or `SignedOut`.
#[unsafe(no_mangle)]
pub extern "C" fn kite_check_sign_in(handle: KiteHandle) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    let (auth, emitter) = (engine.auth.clone(), Arc::clone(&engine.emitter));
    engine.tasks.spawn(async move {
        match auth.load_cached_tokens().await {
            Ok(true) => emitter.simple(KiteEventKind::SignedIn),
            Ok(false) => emitter.simple(KiteEventKind::SignedOut),
            Err(e) => emitter.text(KiteEventKind::Error, &e.to_string()),
        }
    });
    KiteStatus::Ok
}

/// How long `kite_sign_in` waits for the user to finish in the browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

/// Start a browser sign-in: emits `SignInUrl`, then `SignedIn` or `Error`.
#[unsafe(no_mangle)]
pub extern "C" fn kite_sign_in(handle: KiteHandle) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    let (auth, emitter) = (engine.auth.clone(), Arc::clone(&engine.emitter));
    engine.tasks.spawn(async move {
        match auth.start_auth_code_flow().await {
            Ok(url) => emitter.text(KiteEventKind::SignInUrl, &url),
            Err(e) => return emitter.text(KiteEventKind::Error, &e.to_string()),
        }
        let deadline = tokio::time::Instant::now() + SIGN_IN_TIMEOUT;
        while tokio::time::Instant::now() < deadline && !emitter.is_closed() {
            if auth.is_authenticated().await {
                return emitter.simple(KiteEventKind::SignedIn);
            }
            if let Some(error) = auth.take_flow_error().await {
                return emitter.text(KiteEventKind::Error, &error);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        emitter.text(KiteEventKind::Error, "sign-in timed out");
    });
    KiteStatus::Ok
}

/// Forget the saved sign-in: emits `SignedOut` or `Error`.
#[unsafe(no_mangle)]
pub extern "C" fn kite_sign_out(handle: KiteHandle) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    let (auth, emitter) = (engine.auth.clone(), Arc::clone(&engine.emitter));
    engine.tasks.spawn(async move {
        match auth.sign_out().await {
            Ok(()) => emitter.simple(KiteEventKind::SignedOut),
            Err(e) => emitter.text(KiteEventKind::Error, &e.to_string()),
        }
    });
    KiteStatus::Ok
}

/// Fetch the account's consoles: emits `Consoles` or `Error`.
#[unsafe(no_mangle)]
pub extern "C" fn kite_list_consoles(handle: KiteHandle) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    let (auth, emitter) = (engine.auth.clone(), Arc::clone(&engine.emitter));
    engine.tasks.spawn(async move {
        let consoles = async {
            if !auth.load_cached_tokens().await.map_err(|e| e.to_string())? {
                return Err("not signed in".to_string());
            }
            let consoles = XHomeClient::new(auth)
                .get_consoles()
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_string(&consoles).map_err(|e| e.to_string())
        };
        match consoles.await {
            Ok(json) => emitter.text(KiteEventKind::Consoles, &json),
            Err(e) => emitter.text(KiteEventKind::Error, &e),
        }
    });
    KiteStatus::Ok
}

/// Start streaming from the console with this `server_id` (from the `Consoles` event).
/// Emits `Connecting`, `Connected`, `FirstFrame`, `Stats`, `Reconnecting`,
/// `Disconnected`, or `Error`. A stream already running on this engine is closed
/// first, without a `Disconnected` event of its own.
///
/// # Safety
/// `server_id` must be null or point to a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn kite_connect(handle: KiteHandle, server_id: *const c_char) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    if server_id.is_null() {
        return KiteStatus::InvalidArgument;
    }
    // SAFETY: non-null, and the caller promises a NUL-terminated string.
    let Ok(server_id) = unsafe { CStr::from_ptr(server_id) }.to_str() else {
        return KiteStatus::InvalidArgument;
    };
    connect(&engine, server_id.to_owned())
}

#[cfg(not(feature = "native-webrtc"))]
fn connect(_engine: &Engine, _server_id: String) -> KiteStatus {
    KiteStatus::Unsupported
}

#[cfg(feature = "native-webrtc")]
fn connect(engine: &Engine, server_id: String) -> KiteStatus {
    use kite_core::rtc::RtcEvent;

    let (auth, tasks) = (engine.auth.clone(), engine.tasks.clone());
    let start = move || {
        if !tasks
            .block_on(auth.load_cached_tokens())
            .map_err(|e| e.to_string())?
        {
            return Err("not signed in".to_string());
        }
        let mut stream = kite_core::rtc::engine::spawn(auth, server_id, None, None)
            .map_err(|e| e.to_string())?;
        let mut events = stream.take_events();
        let next = move || events.as_mut()?.blocking_recv();
        let events: session::Events = Box::new(std::iter::from_fn(next).map(|event| {
            let deliver: session::Deliver = Box::new(move |emitter: &Emitter| match event {
                RtcEvent::Connecting => emitter.simple(KiteEventKind::Connecting),
                RtcEvent::Connected => emitter.simple(KiteEventKind::Connected),
                RtcEvent::FirstFrame => emitter.simple(KiteEventKind::FirstFrame),
                RtcEvent::Reconnecting { attempt } => {
                    emitter.emit(KiteEventKind::Reconnecting, None, |e| e.attempt = attempt)
                }
                RtcEvent::Stats(s) => emitter.emit(KiteEventKind::Stats, None, |e| {
                    e.bitrate_kbps = s.bitrate_kbps;
                    e.fps = s.fps;
                    e.frames_decoded = s.frames_decoded;
                    e.freeze_count = s.freeze_count;
                }),
                RtcEvent::Disconnected(reason) => {
                    emitter.text(KiteEventKind::Disconnected, &reason)
                }
            });
            deliver
        }));
        Ok((stream, events))
    };
    match engine.sessions.connect(start) {
        Ok(()) => KiteStatus::Ok,
        Err(e) => fail(format!("could not start the session thread: {e}")),
    }
}

/// End the stream, or cancel a connect still in progress. Returns at once;
/// `Disconnected` is emitted when the stream has closed on the console. Returns
/// `KITE_STATUS_NOT_CONNECTED` when there was nothing to end.
#[unsafe(no_mangle)]
pub extern "C" fn kite_disconnect(handle: KiteHandle) -> KiteStatus {
    let engine = match engine(handle) {
        Ok(e) => e,
        Err(status) => return status,
    };
    #[cfg(feature = "native-webrtc")]
    if engine.sessions.disconnect() {
        return KiteStatus::Ok;
    }
    let _ = engine;
    KiteStatus::NotConnected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    static CALLS: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" fn count(_user: *mut c_void, _event: *const KiteEvent) {
        CALLS.fetch_add(1, Ordering::SeqCst);
    }

    #[test]
    fn a_handle_that_was_never_issued_is_rejected_by_every_command() {
        for bad in [0, u64::MAX] {
            assert_eq!(kite_free(bad), KiteStatus::InvalidHandle);
            assert_eq!(kite_check_sign_in(bad), KiteStatus::InvalidHandle);
            assert_eq!(kite_sign_in(bad), KiteStatus::InvalidHandle);
            assert_eq!(kite_sign_out(bad), KiteStatus::InvalidHandle);
            assert_eq!(kite_list_consoles(bad), KiteStatus::InvalidHandle);
            assert_eq!(kite_disconnect(bad), KiteStatus::InvalidHandle);
            // SAFETY: a valid C string; the handle is rejected before it is read.
            let status = unsafe { kite_connect(bad, c"id".as_ptr()) };
            assert_eq!(status, KiteStatus::InvalidHandle);
        }
    }

    #[test]
    fn freeing_twice_is_reported_not_undefined() {
        let h = kite_new(None, std::ptr::null_mut());
        assert_ne!(h, 0);
        assert_eq!(kite_free(h), KiteStatus::Ok);
        assert_eq!(kite_free(h), KiteStatus::InvalidHandle);
        assert_eq!(kite_list_consoles(h), KiteStatus::InvalidHandle);
    }

    #[test]
    fn connect_rejects_a_null_or_non_utf8_server_id() {
        let h = kite_new(None, std::ptr::null_mut());
        // SAFETY: null is allowed by the contract; the second is NUL-terminated.
        unsafe {
            assert_eq!(
                kite_connect(h, std::ptr::null()),
                KiteStatus::InvalidArgument
            );
            assert_eq!(
                kite_connect(h, c"\xff".as_ptr()),
                KiteStatus::InvalidArgument
            );
        }
        assert_eq!(kite_disconnect(h), KiteStatus::NotConnected);
        assert_eq!(kite_free(h), KiteStatus::Ok);
    }

    #[test]
    fn last_error_is_never_null() {
        assert!(!kite_last_error().is_null());
        assert_eq!(fail("boom"), KiteStatus::Failed);
        // SAFETY: just set on this thread, NUL-terminated by CString.
        let text = unsafe { CStr::from_ptr(kite_last_error()) };
        assert_eq!(text.to_str().unwrap(), "boom");
    }

    static FREED_FROM_CALLBACK: AtomicU64 = AtomicU64::new(0);

    unsafe extern "C" fn free_self(user: *mut c_void, _event: *const KiteEvent) {
        let status = kite_free(user as KiteHandle);
        FREED_FROM_CALLBACK.store(status as u64 + 100, Ordering::SeqCst);
    }

    #[test]
    fn free_from_inside_the_callback_is_refused_not_deadlocked() {
        let h = kite_new(Some(free_self), std::ptr::null_mut());
        let engine = engine(h).unwrap();
        let emitter = Emitter {
            callback: Some(free_self),
            user_data: h as usize,
            closed: Mutex::new(false),
        };
        emitter.simple(KiteEventKind::Stats);
        assert_eq!(
            FREED_FROM_CALLBACK.load(Ordering::SeqCst),
            KiteStatus::Failed as u64 + 100
        );
        drop(engine);
        assert_eq!(
            kite_free(h),
            KiteStatus::Ok,
            "still alive, and freeable outside"
        );
    }

    #[test]
    fn no_callback_arrives_after_free_returns() {
        let h = kite_new(Some(count), std::ptr::null_mut());
        let engine = engine(h).unwrap();
        // A plain thread that emits as fast as it can and outlives the engine, like
        // the session's event thread. Only the emitter's own gate can stop it.
        let emitter = Arc::clone(&engine.emitter);
        std::thread::spawn(move || {
            while !emitter.is_closed() {
                emitter.simple(KiteEventKind::Stats);
            }
        });
        drop(engine);
        while CALLS.load(Ordering::SeqCst) < 100 {
            std::thread::yield_now();
        }
        assert_eq!(kite_free(h), KiteStatus::Ok);
        let at_free = CALLS.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(CALLS.load(Ordering::SeqCst), at_free);
    }
}
