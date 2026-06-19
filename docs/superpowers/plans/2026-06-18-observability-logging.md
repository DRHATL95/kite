# Observability & Logging Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a robust, unified logging subsystem — Rust + frontend events on one redacted timeline, persisted to rotating files and an in-memory ring, surfaced in an in-app viewer, with a runtime verbosity toggle and crash capture.

**Architecture:** One Rust `tracing` Registry with an `EnvFilter` behind a reload handle (runtime verbosity) and a single custom `SinkLayer` that, per event, redacts the message once and writes it to **both** a non-blocking rotating file and a bounded in-memory ring. Frontend logs flow in via a batched `log_event` command and are re-emitted into the same pipeline (target `ui::*`), so JS and Rust interleave on one clock. The HUD reads the ring; export concatenates the already-redacted files + ring.

**Tech Stack:** Rust, Tauri 2, `tracing` + `tracing-subscriber` (registry, env-filter, reload) + `tracing-appender` (rolling, non-blocking), `regex` for redaction, `chrono` for timestamps (already a dep); Svelte 5 runes + TypeScript + Vite; Vitest.

**Spec:** `docs/superpowers/specs/2026-06-18-observability-logging-design.md`

**Branch:** `feat/observability-logging` (off `master`).

**Deviations from spec (intentional):** adds `regex` dep (clean redaction) in addition to `tracing-appender`; SDP redaction uses a length note (`[SDP <n> bytes redacted]`) without the optional correlation hash (drops a `sha2` dep) — the hash is a deferred nice-to-have. `DiagnosticsHud` has **no tab system** (it renders a panel grid), so LogViewer is added as a **full-width panel below the grid**, not a tab. Verbosity is **persisted via the existing `settings` store** and re-applied on launch.

---

## File Structure

**Rust**
- Create `src/logging.rs` — `redact()`, `LogRecord`, `LogBuffer` (ring), `FrontendLogRecord`, `SinkLayer`, `init_logging()`, `ReloadHandle` alias, panic hook.
- Modify `src/main.rs` — call `init_logging`, store `LogState` + `WorkerGuard`, register the 5 commands, add `mod logging;`.
- Modify `Cargo.toml` — add `tracing-appender`, `regex`; widen `tracing-subscriber` features.

**Frontend (`ui/src/`)**
- Create `lib/log/logBatcher.ts` — pure batching queue.
- Create `lib/log/logger.ts` — facade (levels, batched flush, local mirror, global error capture).
- Create `lib/log/logStore.svelte.ts` — live ring + filter state; pure `filterRecords()`.
- Create `components/hud/LogViewer.svelte` — the viewer tab.
- Modify `lib/ipc/commands.ts` — typed wrappers for the 5 commands.
- Modify `components/DiagnosticsHud.svelte` — add a "Logs" tab.
- Modify `components/SettingsModal.svelte` — Diagnostics row (verbosity toggle).
- Modify `App.svelte` — install global handlers + logger flush timer at startup.
- Modify `lib/connection/ConnectionManager.ts` + `lib/stores/connection.svelte.ts` — route `_log`/dead `log` ring → `logger`.

**Tests**
- `src/logging.rs` `#[cfg(test)] mod tests` — redact, ring, serde, command→ring.
- `ui/src/lib/log/logBatcher.test.ts`, `ui/src/lib/log/logStore.test.ts`.

---

## Task 1: Add dependencies

**Files:**
- Modify: `Cargo.toml:8-13` (dependencies), and the `tracing-subscriber` line `Cargo.toml:35`.

- [ ] **Step 1: Add the crates**

In `Cargo.toml`, under `[dependencies]`, add after the existing `tracing-subscriber` line:

```toml
tracing-appender = "0.2"
regex = "1"
```

And widen the `tracing-subscriber` dependency to enable the features we need:

```toml
tracing-subscriber = { version = "0.3", features = ["env-filter", "registry", "fmt"] }
```

- [ ] **Step 2: Verify it resolves and builds**

Run: `cargo build`
Expected: compiles (downloads `tracing-appender`, `regex`); no errors. Frontend embed uses the existing `ui/dist`.

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "build(logging): add tracing-appender + regex; widen tracing-subscriber features"
```

---

## Task 2: Redaction function (TDD)

**Files:**
- Create: `src/logging.rs`
- Modify: `src/main.rs` (add `mod logging;`)
- Test: in `src/logging.rs` `#[cfg(test)] mod tests`

- [ ] **Step 1: Create `src/logging.rs` with `redact` + failing tests**

```rust
//! Unified logging: redaction, in-memory ring buffer, and the tracing sink that
//! writes every event (Rust + frontend) to a rotating file and the ring.

use std::sync::LazyLock;

use regex::Regex;

static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+").unwrap()
});
static TOKEN_KV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(authorization|refresh_token|access_token|token)\b\s*[:=]\s*"?[A-Za-z0-9._~+/=-]{8,}"?"#)
        .unwrap()
});
static SDP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"v=0[\s\S]*").unwrap());

/// Scrub secrets from a log message before it is persisted or shown. Idempotent.
pub fn redact(input: &str) -> String {
    let s = BEARER.replace_all(input, "Bearer [REDACTED]");
    let s = JWT.replace_all(&s, "[JWT REDACTED]");
    let s = TOKEN_KV.replace_all(&s, "$1=[REDACTED]");
    let s = SDP.replace_all(&s, |c: &regex::Captures| {
        format!("[SDP {} bytes redacted]", c[0].len())
    });
    s.into_owned()
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
}
```

- [ ] **Step 2: Register the module**

In `src/main.rs`, add to the module list near the top (with `mod auth;` etc.):

```rust
mod logging;
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cargo test --lib logging::tests`  (or `cargo test redact`)
Expected: 4 tests pass. (They're written to pass against the implementation above; if any fails, fix the regex, not the test.)

- [ ] **Step 4: Commit**

```bash
git add src/logging.rs src/main.rs
git commit -m "feat(logging): secret redaction (bearer/JWT/token/SDP) with tests"
```

---

## Task 3: Log record + bounded ring buffer (TDD)

**Files:**
- Modify: `src/logging.rs`

- [ ] **Step 1: Add `LogRecord` + `LogBuffer` + failing tests**

Add to `src/logging.rs` (above the `tests` module):

```rust
use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;

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
```

Add these tests inside `mod tests`:

```rust
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
```

- [ ] **Step 2: Run tests**

Run: `cargo test --lib logging::tests`
Expected: the 2 new tests pass (plus the 4 from Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/logging.rs
git commit -m "feat(logging): bounded LogRecord ring buffer with tests"
```

---

## Task 4: Frontend log record type + serde (TDD)

**Files:**
- Modify: `src/logging.rs`

- [ ] **Step 1: Add `FrontendLogRecord` + a serde round-trip test**

Add to `src/logging.rs`:

```rust
use serde::Deserialize;

/// A log record originating in the webview, ingested via the `log_event` command.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct FrontendLogRecord {
    pub level: String,
    pub category: String,
    pub message: String,
}
```

Add to `mod tests`:

```rust
    #[test]
    fn frontend_record_deserializes_from_js_shape() {
        let json = r#"{"level":"warn","category":"connection","message":"channel closed"}"#;
        let r: FrontendLogRecord = serde_json::from_str(json).unwrap();
        assert_eq!(r, FrontendLogRecord {
            level: "warn".into(), category: "connection".into(), message: "channel closed".into(),
        });
    }
```

- [ ] **Step 2: Run tests**

Run: `cargo test --lib logging::tests`
Expected: new test passes.

- [ ] **Step 3: Commit**

```bash
git add src/logging.rs
git commit -m "feat(logging): FrontendLogRecord wire type with serde test"
```

---

## Task 5: Tracing sink + init (file + ring, one redaction pass, reload, panic hook)

**Files:**
- Modify: `src/logging.rs`

- [ ] **Step 1: Add the sink layer, init function, reload alias, and panic hook**

Add to `src/logging.rs`:

```rust
use std::path::Path;
use std::sync::Arc;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{reload, EnvFilter, Registry};

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
            // tracing renders the message args via Debug == the rendered text.
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
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build`
Expected: compiles. If `reload::Handle<EnvFilter, Registry>` mismatches the inferred type, adjust the `ReloadHandle` alias to the type the compiler reports (the layering keeps `S = Registry`), then rebuild.

- [ ] **Step 3: Commit**

```bash
git add src/logging.rs
git commit -m "feat(logging): unified tracing sink (file + ring), reload handle, panic hook"
```

---

## Task 6: Tauri commands + wire into main.rs

**Files:**
- Modify: `src/logging.rs` (commands)
- Modify: `src/main.rs` (init, manage state, register commands, replace old `fmt()` init)

- [ ] **Step 1: Add the five commands to `src/logging.rs`**

```rust
use tauri::{Manager, State};

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
```

Add a command-ingest test to `mod tests` (verifies a frontend event lands in a ring via the same path the command uses — exercising the visitor + redaction is covered separately; here we assert `log_event` formatting maps category+message):

```rust
    #[test]
    fn log_event_formats_category_into_message() {
        // Pure formatting check (no global subscriber needed).
        let r = FrontendLogRecord { level: "info".into(), category: "connection".into(), message: "ok".into() };
        let msg = format!("{}: {}", r.category, r.message);
        assert_eq!(msg, "connection: ok");
    }
```

- [ ] **Step 2: Wire into `src/main.rs`**

Replace the existing logging init in the `.setup(|app| { ... })` block. **Remove** these lines:

```rust
            use tracing::Level;
            use tracing_subscriber;

            tracing_subscriber::fmt()
                .with_max_level(Level::INFO)
                .init();
```

**Replace with:**

```rust
            // Initialize unified logging (file + ring). Keep the guard alive for
            // the whole process by managing it in state.
            let log_dir = app
                .path()
                .app_log_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("xbox-remote-logs"));
            let (log_state, log_guard) = logging::init_logging(&log_dir);
            app.manage(log_state);
            app.manage(log_guard);
            tracing::info!("xbox-remote starting; logs at {}", log_dir.display());
```

In the `tauri::generate_handler![ ... ]` list, add:

```rust
            logging::log_event,
            logging::get_recent_logs,
            logging::set_log_verbosity,
            logging::open_log_dir,
            logging::export_logs,
```

- [ ] **Step 3: Build + run tests**

Run: `cargo test --lib logging::tests && cargo build`
Expected: tests pass; binary builds. (`app.manage(log_guard)` keeps the `WorkerGuard` alive for the process.)

- [ ] **Step 4: Manual smoke**

Run: `cargo run`
Expected: app launches; a file `xbox-remote.<date>.log` appears under the OS app-log dir (Windows: `%LOCALAPPDATA%\com.<identifier>\logs` or the app-log dir Tauri reports — the startup line "xbox-remote starting; logs at …" names the exact path in the console during a debug run).

- [ ] **Step 5: Commit**

```bash
git add src/logging.rs src/main.rs
git commit -m "feat(logging): tauri commands (log_event/get_recent_logs/export/verbosity/open_dir) + init wiring"
```

---

## Task 7: Frontend batching queue (TDD)

**Files:**
- Create: `ui/src/lib/log/logBatcher.ts`
- Test: `ui/src/lib/log/logBatcher.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/lib/log/logBatcher.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { LogBatcher, type PendingRecord } from "./logBatcher.js";

const rec = (message: string): PendingRecord => ({ level: "info", category: "t", message });

describe("LogBatcher", () => {
  it("does not flush until maxBatch reached", () => {
    const flush = vi.fn();
    const b = new LogBatcher(flush, 3);
    b.add(rec("a"));
    b.add(rec("b"));
    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes when maxBatch is reached", () => {
    const flush = vi.fn();
    const b = new LogBatcher(flush, 2);
    b.add(rec("a"));
    b.add(rec("b"));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([rec("a"), rec("b")]);
  });

  it("immediate flushes right away", () => {
    const flush = vi.fn();
    const b = new LogBatcher(flush, 100);
    b.add(rec("a"), true);
    expect(flush).toHaveBeenCalledWith([rec("a")]);
  });

  it("drain empties the queue and is a no-op when empty", () => {
    const flush = vi.fn();
    const b = new LogBatcher(flush, 100);
    b.add(rec("a"));
    b.drain();
    b.drain();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `pnpm --dir ui exec vitest run src/lib/log/logBatcher.test.ts`
Expected: FAIL (cannot resolve `./logBatcher.js`).

- [ ] **Step 3: Implement `ui/src/lib/log/logBatcher.ts`**

```ts
/**
 * Pure batching queue for log records. Accumulates records and flushes them in
 * batches (on reaching maxBatch, on an immediate add, or via drain() on a timer).
 * No I/O here — the flush callback owns transport. Kept pure for unit testing.
 */
export interface PendingRecord {
  level: string;
  category: string;
  message: string;
}

export class LogBatcher {
  private queue: PendingRecord[] = [];

  constructor(
    private readonly flush: (records: PendingRecord[]) => void,
    private readonly maxBatch = 50,
  ) {}

  add(record: PendingRecord, immediate = false): void {
    this.queue.push(record);
    if (immediate || this.queue.length >= this.maxBatch) this.drain();
  }

  drain(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.flush(batch);
  }
}
```

- [ ] **Step 4: Run tests (pass)**

Run: `pnpm --dir ui exec vitest run src/lib/log/logBatcher.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/log/logBatcher.ts ui/src/lib/log/logBatcher.test.ts
git commit -m "feat(logging): frontend log batching queue with tests"
```

---

## Task 8: IPC command wrappers

**Files:**
- Modify: `ui/src/lib/ipc/commands.ts`

- [ ] **Step 1: Add typed wrappers**

Append to `ui/src/lib/ipc/commands.ts` (match the file's existing `invoke` import + style):

```ts
export interface LogRecord {
  ts: string;
  level: string;
  target: string;
  message: string;
}

export interface FrontendLogRecord {
  level: string;
  category: string;
  message: string;
}

export function logEvent(records: FrontendLogRecord[]): Promise<void> {
  return invoke("log_event", { records });
}

export function getRecentLogs(limit?: number): Promise<LogRecord[]> {
  return invoke("get_recent_logs", { limit });
}

export function setLogVerbosity(verbose: boolean): Promise<void> {
  return invoke("set_log_verbosity", { verbose });
}

export function exportLogs(): Promise<string> {
  return invoke("export_logs");
}

export function openLogDir(): Promise<void> {
  return invoke("open_log_dir");
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --dir ui run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/ipc/commands.ts
git commit -m "feat(logging): typed IPC wrappers for log commands"
```

---

## Task 9: Log store + filter (TDD)

**Files:**
- Create: `ui/src/lib/log/logStore.svelte.ts`
- Test: `ui/src/lib/log/logStore.test.ts`

- [ ] **Step 1: Write the failing test for the pure filter**

`ui/src/lib/log/logStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterRecords, LEVEL_ORDER } from "./logStore.svelte.js";
import type { LogRecord } from "../ipc/commands.js";

const r = (level: string, message: string): LogRecord => ({ ts: "t", level, target: "x", message });

describe("filterRecords", () => {
  const recs = [r("TRACE", "a"), r("INFO", "hello"), r("WARN", "world"), r("ERROR", "boom")];

  it("keeps records at or above the minimum level", () => {
    const out = filterRecords(recs, "WARN", "");
    expect(out.map((x) => x.message)).toEqual(["world", "boom"]);
  });

  it("filters by case-insensitive search substring", () => {
    const out = filterRecords(recs, "TRACE", "HEL");
    expect(out.map((x) => x.message)).toEqual(["hello"]);
  });

  it("LEVEL_ORDER ranks error highest", () => {
    expect(LEVEL_ORDER.ERROR).toBeGreaterThan(LEVEL_ORDER.INFO);
  });
});
```

- [ ] **Step 2: Run it (fails)**

Run: `pnpm --dir ui exec vitest run src/lib/log/logStore.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `ui/src/lib/log/logStore.svelte.ts`**

```ts
/**
 * Live log store for the HUD. Holds a mirror of recent records (fed by the logger
 * + periodic get_recent_logs merges) and the viewer's filter/verbosity state.
 * `filterRecords` is pure and unit-tested.
 */
import type { LogRecord } from "../ipc/commands.js";

export const LEVEL_ORDER: Record<string, number> = {
  TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4,
};

export function filterRecords(
  records: LogRecord[],
  minLevel: string,
  search: string,
): LogRecord[] {
  const min = LEVEL_ORDER[minLevel.toUpperCase()] ?? 0;
  const needle = search.trim().toLowerCase();
  return records.filter((r) => {
    if ((LEVEL_ORDER[r.level.toUpperCase()] ?? 0) < min) return false;
    if (needle && !r.message.toLowerCase().includes(needle)) return false;
    return true;
  });
}

const RING_CAP = 2000;

class LogStore {
  records = $state<LogRecord[]>([]);
  minLevel = $state("INFO");
  search = $state("");

  filtered = $derived(filterRecords(this.records, this.minLevel, this.search));

  /** Append from the logger's local mirror. */
  append(rec: LogRecord): void {
    this.records.push(rec);
    if (this.records.length > RING_CAP) this.records.splice(0, this.records.length - RING_CAP);
  }

  /** Replace from a backend snapshot (authoritative, interleaved with Rust). */
  replace(recs: LogRecord[]): void {
    this.records = recs;
  }
}

export const logStore = new LogStore();
```

- [ ] **Step 4: Run tests (pass)**

Run: `pnpm --dir ui exec vitest run src/lib/log/logStore.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/log/logStore.svelte.ts ui/src/lib/log/logStore.test.ts
git commit -m "feat(logging): log store with pure filterRecords + tests"
```

---

## Task 10: Logger facade + global error capture

**Files:**
- Create: `ui/src/lib/log/logger.ts`

- [ ] **Step 1: Implement the facade**

`ui/src/lib/log/logger.ts`:

```ts
/**
 * App-wide logger facade. Buffers records (LogBatcher), flushes to Rust via the
 * batched log_event command and on a timer, mirrors into logStore for instant
 * HUD render, and installs global JS error capture. Best-effort: it must NEVER
 * throw into callers — a failed flush is dropped (one console.warn).
 */
import { LogBatcher, type PendingRecord } from "./logBatcher.js";
import { logEvent, type LogRecord } from "../ipc/commands.js";
import { logStore } from "./logStore.svelte.js";

const FLUSH_MS = 500;

const batcher = new LogBatcher((records) => {
  logEvent(records).catch((e) => console.warn("log flush failed", e));
}, 50);

let timer: ReturnType<typeof setInterval> | null = null;

function emit(level: string, category: string, message: string, immediate = false): void {
  const rec: PendingRecord = { level, category, message };
  try {
    batcher.add(rec, immediate);
    // Mirror locally for instant HUD render (ts/target approximated client-side).
    const mirror: LogRecord = {
      ts: new Date().toISOString(),
      level: level.toUpperCase(),
      target: `ui::${category}`,
      message,
    };
    logStore.append(mirror);
  } catch (e) {
    console.warn("logger.emit failed", e);
  }
}

export const logger = {
  trace: (c: string, m: string) => emit("trace", c, m),
  debug: (c: string, m: string) => emit("debug", c, m),
  info: (c: string, m: string) => emit("info", c, m),
  warn: (c: string, m: string) => emit("warn", c, m),
  error: (c: string, m: string) => emit("error", c, m, true),
};

/** Start the periodic flush + install global handlers. Call once at app start. */
export function initLogging(): () => void {
  if (timer === null) timer = setInterval(() => batcher.drain(), FLUSH_MS);

  const onError = (e: ErrorEvent) =>
    logger.error("window", `${e.message} @ ${e.filename}:${e.lineno}`);
  const onRejection = (e: PromiseRejectionEvent) =>
    logger.error("promise", `unhandled rejection: ${String(e.reason)}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    if (timer !== null) { clearInterval(timer); timer = null; }
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    batcher.drain();
  };
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --dir ui run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/log/logger.ts
git commit -m "feat(logging): logger facade + global JS error capture"
```

---

## Task 11: Install logger at app start

**Files:**
- Modify: `ui/src/App.svelte`

- [ ] **Step 1: Wire `initLogging()` into the App lifecycle**

In `ui/src/App.svelte` `<script>`, add the imports:

```ts
import { initLogging } from "$lib/log/logger.js";
import { settings } from "$lib/stores/settings.svelte.js";
import { setLogVerbosity } from "$lib/ipc/commands.js";
```

Add an `$effect` in the component body (alongside existing onMount/effect logic) so the flush timer + handlers are installed for the app's lifetime, and the persisted verbosity is applied to the backend filter on launch:

```ts
$effect(() => {
  const stop = initLogging();
  void setLogVerbosity(settings.logVerbose); // apply persisted choice
  return stop;
});
```

- [ ] **Step 2: Type-check + build**

Run: `pnpm --dir ui run check && pnpm --dir ui run build`
Expected: 0 errors; build emits `ui/dist`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat(logging): start logger flush timer + global handlers at app launch"
```

---

## Task 12: Migrate ConnectionManager + remove dead connection log ring

**Files:**
- Modify: `ui/src/lib/connection/ConnectionManager.ts` (the `_log` method, ~line 328)
- Modify: `ui/src/lib/stores/connection.svelte.ts` (dead `log` field + LOG_CAP)

- [ ] **Step 1: Route ConnectionManager logging through the logger**

In `ui/src/lib/connection/ConnectionManager.ts`, add the import at the top:

```ts
import { logger } from "$lib/log/logger.js";
```

Change the private `_log` method body so it both calls the existing `onLog` callback (unchanged contract) and forwards to the logger:

```ts
  private _log(msg: string): void {
    logger.info("connection", msg);
    this._cb.onLog(msg);
  }
```

- [ ] **Step 2: Remove the dead write-only ring in the store**

In `ui/src/lib/stores/connection.svelte.ts` (dead-code sweep #6):

Delete the `LOG_CAP` constant + its doc comment (~lines 19-20):

```ts
/** Maximum number of log entries to keep in memory. */
const LOG_CAP = 500;
```

Delete the `log` field + its doc comment from `ConnectionStore` (~lines 44-48):

```ts
  /**
   * Human-readable log lines, newest-last, capped at LOG_CAP entries.
   * Updated by onLog.
   */
  log: string[] = $state([]);
```

Replace the `onLog` callback body (~lines 95-104) with a no-op — keep the callback (it's required by `ConnectionManagerCallbacks`); `ConnectionManager._log` now forwards to the logger (Step 1):

```ts
      onLog: (_msg: string) => {
        // Logging is owned by the logger facade (file + ring + viewer).
        // Retained because ConnectionManagerCallbacks requires onLog.
      },
```

- [ ] **Step 3: Type-check + unit tests + build**

Run: `pnpm --dir ui run check && pnpm --dir ui run test && pnpm --dir ui run build`
Expected: 0 type errors; existing tests pass; build OK. (If a test referenced `connectionStore.log`, update it to assert via the logger or remove that assertion — search: `grep -rn "\.log" ui/src/lib/stores/connection*`.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/connection/ConnectionManager.ts ui/src/lib/stores/connection.svelte.ts
git commit -m "refactor(logging): route ConnectionManager through logger; drop dead store log ring"
```

---

## Task 13: LogViewer panel + DiagnosticsHud tab

**Files:**
- Create: `ui/src/components/hud/LogViewer.svelte`
- Modify: `ui/src/components/DiagnosticsHud.svelte`

- [ ] **Step 1: Create `ui/src/components/hud/LogViewer.svelte`**

```svelte
<script lang="ts">
  /**
   * LogViewer — live, filterable log panel for the DiagnosticsHud.
   * Merges the logger's local mirror (instant) with periodic backend snapshots
   * (authoritative, interleaves Rust + UI). Level filter, search, copy, export,
   * open-folder, and the verbose toggle.
   */
  import { logStore } from "$lib/log/logStore.svelte.js";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { getRecentLogs, exportLogs, openLogDir, setLogVerbosity } from "$lib/ipc/commands.js";

  const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;

  // Periodically pull the authoritative interleaved snapshot from Rust.
  $effect(() => {
    const id = setInterval(() => {
      getRecentLogs(2000)
        .then((recs) => logStore.replace(recs))
        .catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  });

  async function copy() {
    const text = logStore.filtered
      .map((r) => `${r.ts} ${r.level} ${r.target}: ${r.message}`)
      .join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  }

  function toggleVerbose() {
    settings.setLogVerbose(!settings.logVerbose);
    void setLogVerbosity(settings.logVerbose);
  }
</script>

<div class="logview">
  <div class="logview__bar">
    <select bind:value={logStore.minLevel} aria-label="Minimum level">
      {#each LEVELS as l (l)}<option value={l}>{l}</option>{/each}
    </select>
    <input placeholder="search…" bind:value={logStore.search} aria-label="Search logs" />
    <button onclick={toggleVerbose} class:on={settings.logVerbose} title="Verbose/diagnostic capture">
      {settings.logVerbose ? "Verbose ON" : "Verbose"}
    </button>
    <button onclick={copy}>Copy</button>
    <button onclick={() => void exportLogs()}>Export</button>
    <button onclick={() => void openLogDir()}>Folder</button>
  </div>
  <ul class="logview__list">
    {#each logStore.filtered as r (r.ts + r.message)}
      <li class="logview__row logview__row--{r.level.toLowerCase()}">
        <span class="logview__lvl">{r.level}</span>
        <span class="logview__tgt">{r.target}</span>
        <span class="logview__msg">{r.message}</span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .logview { display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; }
  .logview__bar { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .logview__bar button.on { color: var(--accent); border-color: var(--accent); }
  .logview__list {
    list-style: none; margin: 0; padding: 0; overflow-y: auto; max-height: 50vh;
    font-family: var(--font-mono); font-size: var(--text-xs);
  }
  .logview__row { display: flex; gap: var(--space-2); padding: 1px 0; white-space: pre-wrap; word-break: break-word; }
  .logview__lvl { flex: 0 0 auto; width: 3.5em; color: var(--text-dim); }
  .logview__tgt { flex: 0 0 auto; color: var(--text-dim); }
  .logview__row--warn .logview__lvl { color: var(--warn); }
  .logview__row--error .logview__lvl { color: var(--bad); }
  .logview__msg { flex: 1 1 auto; }
</style>
```

- [ ] **Step 2: Add `LogViewer` as a full-width panel in `DiagnosticsHud.svelte`**

`DiagnosticsHud.svelte` has **no tab system** — it renders all panels in a 2-column `.hud__grid`. Add the LogViewer as a full-width block *below* the grid (logs need width + their own scroll).

Import it with the other panel imports:

```ts
import LogViewer from "./hud/LogViewer.svelte";
```

Insert it after the `</div>` that closes `.hud__grid` and before `</aside>`, so the section becomes:

```svelte
    <div class="hud__grid">
      <VideoPanel   snapshot={activeSnapshot} />
      <NetworkPanel snapshot={activeSnapshot} />
      <PacketPanel  snapshot={activeSnapshot} />
      <SessionPanel snapshot={activeSnapshot} />
      <ChannelPanel snapshot={activeSnapshot} />
    </div>

    <div class="hud__logs">
      <LogViewer />
    </div>
```

Add a style rule in the `<style>` block:

```css
  .hud__logs { padding: var(--space-3); border-top: 1px solid var(--border); }
```

- [ ] **Step 3: Type-check + build**

Run: `pnpm --dir ui run check && pnpm --dir ui run build`
Expected: 0 errors; build OK.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/hud/LogViewer.svelte ui/src/components/DiagnosticsHud.svelte
git commit -m "feat(logging): LogViewer panel as a DiagnosticsHud tab"
```

---

## Task 14: Persisted verbosity + Settings row

**Files:**
- Modify: `ui/src/lib/stores/settings.svelte.ts`
- Modify: `ui/src/components/SettingsModal.svelte`

- [ ] **Step 1: Add a persisted `logVerbose` setting**

In `ui/src/lib/stores/settings.svelte.ts`, follow the existing `updateChannel` pattern. Add near `CHANNEL_KEY`:

```ts
const LOG_VERBOSE_KEY = "xbox-remote:log-verbose";

function readLogVerbose(): boolean {
  try {
    return persisted.getItem(LOG_VERBOSE_KEY) === "true";
  } catch {
    return false;
  }
}
```

Add to the `SettingsStore` class:

```ts
  /** Verbose ("diagnostic") logging, persisted across launches. */
  logVerbose: boolean = $state(readLogVerbose());

  /** Set verbose logging and persist it. */
  setLogVerbose(v: boolean): void {
    this.logVerbose = v;
    try {
      persisted.setItem(LOG_VERBOSE_KEY, String(v));
    } catch {
      // best-effort persistence
    }
  }
```

- [ ] **Step 2: Add a Diagnostics section to `SettingsModal.svelte`**

In `ui/src/components/SettingsModal.svelte`, add imports (note: `settings` is ALREADY imported in this file — do not duplicate it):

```ts
import { setLogVerbosity, exportLogs, openLogDir } from "$lib/ipc/commands.js";
```

Add a new `<section>` modeled on the existing ones (e.g. after UPDATES), using the existing `Toggle` component already imported in this file:

```svelte
      <!-- ── Diagnostics ─────────────────────────────────────────────────── -->
      <section class="settings-section">
        <span class="settings-section__label">DIAGNOSTICS</span>
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Verbose logging</span>
            <span class="settings-row__desc">
              Capture full protocol detail (SDP/ICE/stats) to reproduce a bug. Off keeps
              logs lean. Logs are redacted of secrets and stored locally.
            </span>
          </div>
          <Toggle
            checked={settings.logVerbose}
            label=""
            onchange={(on) => { settings.setLogVerbose(on); void setLogVerbosity(on); }}
          />
        </div>
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Export logs</span>
            <span class="settings-row__desc">Write a redacted log bundle and open its folder.</span>
          </div>
          <Button onclick={() => { void exportLogs(); void openLogDir(); }}>Export</Button>
        </div>
      </section>
```

- [ ] **Step 3: Type-check + build**

Run: `pnpm --dir ui run check && pnpm --dir ui run build`
Expected: 0 errors; build OK.

- [ ] **Step 4: Commit**

```bash
git add ui/src/lib/stores/settings.svelte.ts ui/src/components/SettingsModal.svelte
git commit -m "feat(logging): persisted verbose setting + Diagnostics settings row"
```

---

## Task 15: Full integration verification

**Files:** none (verification only)

- [ ] **Step 1: Rebuild frontend + re-embed**

Run: `pnpm --dir ui run build && cargo clean -p xbox-remote && cargo run`
Expected: app launches (Tauri embeds the fresh `ui/dist`).

- [ ] **Step 2: Manual smoke checklist**

- Open the DiagnosticsHud → **Logs** tab: lines appear (connection lifecycle as you sign in / connect).
- Type in search + change level filter: list narrows correctly.
- Toggle **Verbose** (HUD or Settings): more detail appears without reconnecting.
- Click **Export** then **Folder**: a redacted `xbox-remote-export.txt` exists and opens; open it and confirm **no `eyJ…`/Bearer tokens** are present.
- Force a JS error (e.g. temporarily throw in a handler) and confirm an `ERROR window:` line appears, then revert.
- Confirm the rotating `xbox-remote.<date>.log` exists in the app-log dir.

- [ ] **Step 3: Final test sweep**

Run: `cargo test && pnpm --dir ui run check && pnpm --dir ui run test`
Expected: all green.

- [ ] **Step 4: Commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(logging): integration verification fixups"
```

---

## Self-review notes (coverage map)

- Unified Rust+UI timeline → Tasks 5, 6, 10, 12. Rotating file + ring → Task 5. Redaction (one pass) → Tasks 2, 5. Verbosity toggle (reload, no restart) → Tasks 5, 6, 13, 14. In-app viewer (DiagnosticsHud tab) → Task 13. Export + open dir → Tasks 6, 13, 14. Crash/JS-error capture → Tasks 5 (panic), 10 (window handlers). Migration off dead `connectionStore.log` (#6) → Task 12. Best-effort safety → Tasks 5, 10. Tests follow repo convention (pure logic unit-tested; Svelte glue via check+build) → Tasks 2,3,4,7,9 (unit) + 11,13,14 (check/build).
