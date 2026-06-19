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
