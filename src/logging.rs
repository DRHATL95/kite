//! Unified logging: redaction, in-memory ring buffer, and the tracing sink that
//! writes every event (Rust + frontend) to a rotating file and the ring.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use tauri::State;

use serde::{Deserialize, Serialize};

use regex::Regex;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{reload, EnvFilter, Registry};

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap()
});
// JSON form: "sensitiveKey": "value"  (handles the quote between key and colon)
static KV_QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)"(authorization|refresh_token|access_token|auth_token|accesstoken|authtoken|token|xsts)"\s*:\s*"[^"]*""#).unwrap()
});
// Unquoted / header / query form: key=value or key: value (value runs to end-of-value)
static KV_UNQUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(authorization|refresh_token|access_token|auth_token|accesstoken|authtoken|token|xsts)\b\s*[:=]\s*"?([^\r\n,}\]"]+)"?"#).unwrap()
});
// Sensitive standalone SDP attribute lines (candidate/IP lines are intentionally KEPT).
static SDP_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)^(\s*a=(?:ice-pwd|fingerprint))\s*:.*$").unwrap()
});
// Whole SDP blob, bounded at a blank line or end-of-string (not greedy past it).
static SDP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"v=0[\s\S]*?(?:\r?\n\r?\n|$)").unwrap()
});

/// Scrub secrets from a log message before it is persisted or shown. Idempotent.
pub fn redact(input: &str) -> String {
    let s = BEARER.replace_all(input, "Bearer [REDACTED]");
    let s = JWT.replace_all(&s, "[JWT REDACTED]");
    let s = KV_QUOTED.replace_all(&s, |c: &regex::Captures| format!("\"{}\":\"[REDACTED]\"", &c[1]));
    let s = KV_UNQUOTED.replace_all(&s, |c: &regex::Captures| format!("{}=[REDACTED]", &c[1]));
    let s = SDP_ATTR.replace_all(&s, "$1:[REDACTED]");
    let s = SDP.replace_all(&s, |c: &regex::Captures| format!("[SDP {} bytes redacted]", c[0].len()));
    s.into_owned()
}

/// A log record originating in the webview, ingested via the `log_event` command.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FrontendLogRecord {
    pub level: String,
    pub category: String,
    pub message: String,
}

/// One log line surfaced to the UI and export. Already redacted.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LogRecord {
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: String,
}

/// Bounded in-memory ring of the most recent records (oldest evicted).
pub struct LogBuffer {
    ring: Mutex<VecDeque<LogRecord>>,
    cap: usize,
}

impl LogBuffer {
    pub fn new(cap: usize) -> Self {
        Self { ring: Mutex::new(VecDeque::with_capacity(cap)), cap }
    }

    pub fn push(&self, rec: LogRecord) {
        let mut r = self.ring.lock().unwrap();
        if r.len() >= self.cap {
            r.pop_front();
        }
        r.push_back(rec);
    }

    /// Most recent `limit` records (all if `None`), oldest-first.
    pub fn snapshot(&self, limit: Option<usize>) -> Vec<LogRecord> {
        let r = self.ring.lock().unwrap();
        let n = limit.unwrap_or(r.len()).min(r.len());
        r.iter().skip(r.len() - n).cloned().collect()
    }
}

/// Handle used to change the active log level filter at runtime.
pub type ReloadHandle = reload::Handle<EnvFilter, Registry>;

/// Default filter: info everywhere, our crate + ui at info.
const DEFAULT_FILTER: &str = "info,xbox_remote=info,ui=info";
/// Verbose ("diagnostic mode") filter.
const VERBOSE_FILTER: &str = "debug,xbox_remote=trace,ui=trace";
const RING_CAPACITY: usize = 2000;

/// Visitor that extracts the `message` field of an event.
#[derive(Default)]
struct MsgVisitor(String);
impl Visit for MsgVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
}

/// One custom layer that redacts once and writes to BOTH the ring and the file.
struct SinkLayer {
    buf: Arc<LogBuffer>,
    file: NonBlocking,
}

impl<S: Subscriber> Layer<S> for SinkLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut v = MsgVisitor::default();
        event.record(&mut v);
        let meta = event.metadata();
        let message = redact(&v.0);
        let ts = chrono::Utc::now().to_rfc3339();
        let rec = LogRecord {
            ts: ts.clone(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            message: message.clone(),
        };
        self.buf.push(rec);
        use std::io::Write;
        let mut w = self.file.clone();
        let _ = writeln!(w, "{ts} {:>5} {}: {message}", meta.level(), meta.target());
    }
}

/// Resources kept alive for the life of the process / exposed to commands.
pub struct LogState {
    pub buf: Arc<LogBuffer>,
    pub reload: ReloadHandle,
    pub log_dir: std::path::PathBuf,
}

/// Build and install the global subscriber. Returns the state to manage + the
/// appender guard (MUST be kept alive — drop = stop flushing).
pub fn init_logging(log_dir: &Path) -> (LogState, WorkerGuard) {
    std::fs::create_dir_all(log_dir).ok();

    let file_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .max_log_files(5)
        .filename_prefix("xbox-remote")
        .filename_suffix("log")
        .build(log_dir)
        .expect("init rolling log appender");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let buf = Arc::new(LogBuffer::new(RING_CAPACITY));
    let (filter, reload_handle) = reload::Layer::new(EnvFilter::new(DEFAULT_FILTER));

    Registry::default()
        .with(filter)
        .with(SinkLayer { buf: buf.clone(), file: non_blocking })
        .init();

    install_panic_hook();

    (
        LogState { buf, reload: reload_handle, log_dir: log_dir.to_path_buf() },
        guard,
    )
}

fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        tracing::error!(target: "panic", "panic at {loc}: {info}");
        prev(info);
    }));
}

/// Apply the verbose or default filter at runtime.
pub fn set_verbose(state: &LogState, verbose: bool) {
    let directive = if verbose { VERBOSE_FILTER } else { DEFAULT_FILTER };
    let _ = state.reload.reload(EnvFilter::new(directive));
}

#[tauri::command]
pub fn log_event(records: Vec<FrontendLogRecord>) {
    for r in records {
        // target must be a literal; carry the category in the message.
        let msg = format!("{}: {}", r.category, r.message);
        match r.level.as_str() {
            "error" => tracing::error!(target: "ui", "{msg}"),
            "warn" => tracing::warn!(target: "ui", "{msg}"),
            "debug" => tracing::debug!(target: "ui", "{msg}"),
            "trace" => tracing::trace!(target: "ui", "{msg}"),
            _ => tracing::info!(target: "ui", "{msg}"),
        }
    }
}

#[tauri::command]
pub fn get_recent_logs(limit: Option<usize>, state: State<'_, LogState>) -> Vec<LogRecord> {
    state.buf.snapshot(limit)
}

#[tauri::command]
pub fn set_log_verbosity(verbose: bool, state: State<'_, LogState>) {
    set_verbose(&state, verbose);
    tracing::info!(target: "logging", "verbosity set: verbose={verbose}");
}

#[tauri::command]
pub fn open_log_dir(app: tauri::AppHandle, state: State<'_, LogState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(state.log_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Concatenate the already-redacted rotated files + the live ring into one .txt.
#[tauri::command]
pub fn export_logs(state: State<'_, LogState>) -> Result<String, String> {
    let mut out = String::new();
    if let Ok(entries) = std::fs::read_dir(&state.log_dir) {
        let mut files: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|x| x == "log").unwrap_or(false))
            .collect();
        files.sort();
        for f in files {
            if let Ok(text) = std::fs::read_to_string(&f) {
                out.push_str(&text);
            }
        }
    }
    out.push_str("\n--- in-memory ring ---\n");
    for r in state.buf.snapshot(None) {
        out.push_str(&format!("{} {:>5} {}: {}\n", r.ts, r.level, r.target, r.message));
    }
    let path = state.log_dir.join("xbox-remote-export.txt");
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bearer_and_jwt() {
        let jwt = "eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM";
        let out = redact(&format!("Authorization: Bearer {jwt}"));
        assert!(!out.contains(jwt), "jwt leaked: {out}");
        assert!(out.contains("[REDACTED]") || out.contains("[JWT REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_token_kv() {
        let out = redact(r#"refresh_token: "M.C123_abcDEF456ghi""#);
        assert!(out.contains("refresh_token=[REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_sdp_blob() {
        let out = redact("offer v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\nm=audio 9 ...");
        assert!(out.contains("[SDP "), "{out}");
        assert!(!out.contains("m=audio"), "sdp leaked: {out}");
    }

    #[test]
    fn preserves_ordinary_text() {
        let msg = "state=connected status=200 keepAlive=30s gamertag=Player1";
        assert_eq!(redact(msg), msg);
    }

    #[test]
    fn redacts_json_quoted_token() {
        let out = redact(r#"resp {"Token":"AbCdEf0123456789opaqueXSTS"}"#);
        assert!(!out.contains("AbCdEf0123456789opaqueXSTS"), "leaked: {out}");
        assert!(out.contains("[REDACTED]"), "{out}");
    }

    #[test]
    fn redacts_json_access_token_with_space() {
        let out = redact(r#"{"access_token": "EwAoA8secretvalue123"}"#);
        assert!(!out.contains("EwAoA8secretvalue123"), "leaked: {out}");
    }

    #[test]
    fn redacts_opaque_authorization_header() {
        let out = redact("Authorization: XBL3.0 x=uhs;EwAoSecretXstsToken99");
        assert!(!out.contains("EwAoSecretXstsToken99"), "leaked: {out}");
    }

    #[test]
    fn redacts_sdp_ice_pwd_but_keeps_candidate_ip() {
        let out = redact("a=ice-pwd:SuperSecretIcePwd123\r\na=candidate:1 1 udp 2 192.168.1.5 9 typ host");
        assert!(!out.contains("SuperSecretIcePwd123"), "ice-pwd leaked: {out}");
        assert!(out.contains("192.168.1.5"), "LAN candidate IP should be preserved: {out}");
    }

    fn rec(msg: &str) -> LogRecord {
        LogRecord { ts: "t".into(), level: "INFO".into(), target: "x".into(), message: msg.into() }
    }

    #[test]
    fn ring_evicts_oldest_at_cap() {
        let buf = LogBuffer::new(2);
        buf.push(rec("a"));
        buf.push(rec("b"));
        buf.push(rec("c"));
        let snap = buf.snapshot(None);
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].message, "b");
        assert_eq!(snap[1].message, "c");
    }

    #[test]
    fn ring_snapshot_limit_returns_most_recent() {
        let buf = LogBuffer::new(10);
        for m in ["a", "b", "c"] { buf.push(rec(m)); }
        let snap = buf.snapshot(Some(2));
        assert_eq!(snap.iter().map(|r| r.message.clone()).collect::<Vec<_>>(), vec!["b", "c"]);
    }

    #[test]
    fn frontend_record_deserializes_from_js_shape() {
        let json = r#"{"level":"warn","category":"connection","message":"channel closed"}"#;
        let r: FrontendLogRecord = serde_json::from_str(json).unwrap();
        assert_eq!(r, FrontendLogRecord {
            level: "warn".into(), category: "connection".into(), message: "channel closed".into(),
        });
    }

    #[test]
    fn log_event_formats_category_into_message() {
        let r = FrontendLogRecord { level: "info".into(), category: "connection".into(), message: "ok".into() };
        let msg = format!("{}: {}", r.category, r.message);
        assert_eq!(msg, "connection: ok");
    }
}
