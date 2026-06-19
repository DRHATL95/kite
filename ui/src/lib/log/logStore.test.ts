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
