/**
 * Live log store for the HUD. Holds a mirror of recent records (fed by the logger
 * + periodic get_recent_logs merges) and the viewer's filter state.
 * `filterRecords` is pure and unit-tested. (Verbosity state lives in the settings
 * store, not here.)
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
