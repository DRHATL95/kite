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
