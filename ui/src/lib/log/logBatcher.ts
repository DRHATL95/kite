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
