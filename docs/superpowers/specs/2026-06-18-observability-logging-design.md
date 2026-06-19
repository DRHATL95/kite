# Observability & Logging Foundation — Design

**Date:** 2026-06-18
**Status:** Approved (design); pending implementation plan
**Sub-project:** 1 of the 1.0 program (foundation). Enabler for the connection/xhome
refactors and for root-causing the Linux Wayland + clipping reconnect bugs.

## Problem

The app has no usable logging story:

- **Rust** logs via `tracing_subscriber::fmt()` to **stdout only**, which is invisible
  in release builds (the Windows console is hidden via `windows_subsystem = "windows"`).
- **Frontend** writes to an in-memory `connectionStore.log` ring that is **rendered
  nowhere** and is dead, write-only state (dead-code sweep finding #6). `ConnectionManager`
  logs through an ad-hoc `_log` → `onLog` callback.
- There is **no persistence**, no export, no crash capture, and **no way to correlate**
  the two runtimes. Every field investigation so far (Wayland video, the intermittent
  clipping reconnect loop) has required hand-rolling a temporary stdout bridge.

The two highest-value bugs are **cross-runtime**: the clipping reconnect loop manifests
as JS data-channel/WebRTC symptoms on one side and Rust keepalive/session-API behavior on
the other. Diagnosing it requires a **single interleaved timeline**.

## Goal

A robust, **field-debug-led** observability foundation, with a good live view as well:

- **Unified** logging across Rust + frontend into one timeline on one clock.
- **Persistent** rotating files on disk (survive crashes; shareable) **and** an in-memory
  ring buffer for the live in-app view.
- **Leveled** (trace/debug/info/warn/error) with a runtime **verbosity toggle**: default
  on-disk level = info + key lifecycle/protocol events; a Settings toggle bumps to
  debug/trace (full SDP/ICE/stats) to reproduce a bug — **without restarting**.
- **Secret redaction** before anything hits disk, so an exported log is safe to share.
- **In-app log viewer** (a tab in the existing DiagnosticsHud) with filter/search/copy/export.
- **Crash capture** for Rust panics and JS uncaught errors/rejections.

**Non-goals (deferred):** remote telemetry / log shipping; machine-readable JSON log
format; per-module filter UI; log-based metrics dashboards.

## Architecture — Approach A: Rust-centric unified sink

One Rust `tracing` `Registry` is the single source of truth. It fans every event to two
layers, after a single redaction pass:

```
                         ┌─────────────────────────────────────────┐
  Rust code  ─tracing──▶ │  Registry                                │
                         │   ├─ EnvFilter (reload handle ◀─toggle)  │
  UI code ─┐             │   ├─ [redaction formatter]               │
           │ log_event   │   ├─▶ rotating FILE layer (tracing-appender, non-blocking)
           └─(batched)──▶ │   └─▶ RING layer (bounded VecDeque in Tauri state)
   IPC, re-emitted as     └─────────────────────────────────────────┘
   tracing events                         │                  │
   (target `ui::*`)              <app-data>/logs/*.log     get_recent_logs → HUD
```

- **File layer:** `tracing-appender` non-blocking rolling appender → `<app-log-dir>/logs/`
  (`app.path().app_log_dir()`). Rotation **daily**, retaining the **last 5 files** (a single
  named constant; `tracing-appender`'s `Builder::max_log_files(5)`). The non-blocking
  `WorkerGuard` is stored in Tauri state so it lives for the process and is flushed on exit.
- **Ring layer:** a custom `tracing_subscriber::Layer` that formats each event and pushes a
  `LogRecord` into a bounded `VecDeque<LogRecord>` (cap ~2000) behind a `Mutex`, held in
  Tauri state. This is what the HUD reads. Oldest entries evicted on overflow.
- **Redaction:** a field visitor / event formatter applied in the layer(s) *before* write,
  so it covers both Rust and UI-originated events in one place. (Details in §Redaction.)
- **Verbosity:** `tracing_subscriber::reload::Handle<EnvFilter>` lets `set_log_verbosity`
  change the active filter at runtime. Default level read from the persisted settings store.

### Frontend → Rust ingestion (one timeline)
Frontend events do **not** keep a separate file/export path. They flow into the same Rust
pipeline:

- `logger.ts` buffers records and flushes them to a **batched** `log_event(records[])`
  command (interval ~500 ms, or immediately on `error`/disconnect/flush triggers).
- Each ingested record is re-emitted as a `tracing` event with target `ui::<category>` and
  the original level, so it gets the same redaction + file + ring treatment and interleaves
  with Rust events by arrival.
- `logger.ts` also mirrors the most recent entries into a small local `$state` ring so the
  HUD renders instantly without round-tripping every line.

## Components

### Rust (`src/logging.rs`, new module)
- `init_logging(app) -> WorkerGuard` — builds the Registry (EnvFilter+reload, redaction,
  file layer, ring layer), installs it, installs the panic hook, returns the appender guard
  (stored in state). Replaces the `tracing_subscriber::fmt()` call in `main.rs` setup.
- `LogRecord { ts, level, target, message }` (serde `Serialize`) — the ring/export item.
- `LogBuffer` — the bounded ring (Tauri-managed state) + the reload handle + the guard.
- `FrontendLogRecord { level, category, message, fields? }` (serde `Deserialize`) — wire
  type for `log_event`.
- `redact(s: &str) -> String` — the single scrubbing function (unit-tested).

### Tauri commands (registered in `main.rs`)
- `log_event(records: Vec<FrontendLogRecord>)` — batched ingest; re-emits into tracing.
- `get_recent_logs(limit: Option<usize>) -> Vec<LogRecord>` — ring snapshot for the HUD.
- `export_logs() -> String` — writes a redacted, concatenated `.txt` (ring + rotated files)
  to the log dir, returns its path; the UI reveals it via opener `revealItemInDir`.
- `set_log_verbosity(level: String)` — flips the reload handle + persists the choice.
- `open_log_dir()` — reveal the log folder (opener `revealItemInDir`).

### Frontend (`ui/src/lib/log/`)
- `logger.ts` — facade: `logger.{trace,debug,info,warn,error}(category, msg, fields?)`,
  batching/flush, local mirror, global `window.onerror` + `unhandledrejection` capture
  (installed once at app start).
- `logStore.svelte.ts` — rune store: live ring (local mirror merged with periodic
  `get_recent_logs`), level filter, search text, verbosity state, auto-scroll flag.
- `LogViewer.svelte` — a **new tab in `DiagnosticsHud`**: virtualized/scrollable list,
  level filter chips, search box, auto-scroll toggle, **Copy** / **Export** / **Open log
  folder** buttons, and the **verbosity toggle** (mirrored in SettingsModal → new
  "Diagnostics" row).
- **Migration:** replace `ConnectionManager._log` and the dead `connectionStore.log`
  (sweep #6) with `logger`; the existing `onLog` callback routes to `logger.info`.

## Data flow

1. Rust event → tracing → redact → file + ring.
2. UI event → `logger` (buffer + local mirror) → batched `log_event` → re-emit into tracing
   (target `ui::*`) → redact → file + ring.
3. HUD: `logStore` merges its local mirror with periodic `get_recent_logs` → `LogViewer`.
4. Export: user clicks Export → `export_logs` → redacted `.txt` in log dir → reveal.
5. Verbosity: Settings/HUD toggle → `set_log_verbosity` → reload handle changes filter live
   + persisted for next launch.

## Error / crash handling

- **Rust panics:** `std::panic::set_hook` logs the payload + location (+ backtrace if
  enabled) at `error`, then flushes the appender before the process unwinds/aborts.
- **JS uncaught:** `window.onerror` + `window.onunhandledrejection` → `logger.error`
  (immediate flush).
- **Logging is best-effort and can never break the app.** Every log call and the batch
  flush swallow their own errors (IPC failure, lock contention) — at most a single
  `console.warn`. This mirrors the clipping "always-enqueue" safety guard (clipping spec §7):
  instrumentation must never disturb the live stream.

## Redaction

A single pass over each record's message before write:

- **Always strip:** `Bearer\s+\S+`; JWT-shaped tokens (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`);
  `Authorization` header values; `Token=`/refresh-token values; the XSTS/access tokens.
- **SDP:** collapse `v=…` blobs to `[SDP <n>B sha8=<hash>]` — keeps a stable correlation
  hash, drops the content.
- **LAN IPs in ICE candidates:** **kept** (decision) — they're the user's own network and
  are useful for NAT/connectivity debugging; the log is the user's own to share.
- **Export format:** single concatenated, redacted `.txt` (decision) — simplest to copy/send;
  zip-of-rotated-files deferred.

Redaction has unit tests proving tokens/JWTs/SDP are scrubbed and ordinary text (including
status codes, state names, timings, gamertag/console name) is preserved.

## Performance / safety

- Ring bounded at ~2000 entries; file appender non-blocking (background worker).
- Frontend flush batched (~500 ms) and gated by the verbosity level — at default level it's
  a trickle of lifecycle events.
- **No per-frame logging on the hot media path** except at `trace` (the clip tap and stats
  sampler already run there; they stay silent unless diagnostic mode is on).

## Testing

- **Rust unit tests:** `redact()` (tokens/JWT/SDP scrubbed; non-secrets preserved); ring
  cap + eviction; `FrontendLogRecord` serde round-trip; (smoke) an ingested `log_event`
  record appears in `get_recent_logs`.
- **Frontend (vitest):** `logger` batching/flush logic and `logStore` filter/merge (pure
  logic, the repo's unit-test convention); `LogViewer` covered by `pnpm check` + build, per
  the established "pure logic unit-tested, Svelte/rune glue by type-check+build" philosophy.

## Dependencies & touched files

- **New crate:** `tracing-appender` (rolling, non-blocking file output).
- **Cargo features:** ensure `tracing-subscriber` has `registry`, `env-filter`, `reload`.
- **New:** `src/logging.rs`; `ui/src/lib/log/{logger.ts,logStore.svelte.ts}`;
  `ui/src/components/hud/LogViewer.svelte`.
- **Modified:** `src/main.rs` (init + command registration), `ui/src/components/DiagnosticsHud.svelte`
  (new tab), `ui/src/components/SettingsModal.svelte` (verbosity row),
  `ui/src/lib/connection/ConnectionManager.ts` + `ui/src/lib/stores/connection.svelte.ts`
  (route `_log`/remove dead `log` ring → `logger`), `capabilities/default.json`
  (opener reveal already granted; confirm), `ui/src/App.svelte` (install global handlers).

## Out of scope / follow-ups

- Remote telemetry / log shipping; JSON log format; per-module filter UI; metrics.
- The connection/xhome refactors (sub-projects 2 & 3) **consume** this logging interface but
  are separate specs.
