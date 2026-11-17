import { describe, it, expect } from "vitest";
import { selectReleases, type RawRelease } from "./releaseNotes.js";

const raw: RawRelease[] = [
  { tag_name: "stable", name: "v1.0.0", published_at: "2026-07-05T00:00:00Z", body: "stable pointer" },
  { tag_name: "v1.0.0", name: "v1.0.0", published_at: "2026-07-05T10:00:00Z", body: "First stable." },
  { tag_name: "nightly", name: "Nightly 0.6.0-nightly.40", published_at: "2026-07-06T00:00:00Z", body: "latest nightly" },
];

describe("selectReleases", () => {
  it("drops the rolling 'stable' pointer (it duplicates the latest vX.Y.Z)", () => {
    expect(selectReleases(raw).some((r) => r.notes === "stable pointer")).toBe(false);
  });

  it("sorts newest first by published_at", () => {
    expect(selectReleases(raw).map((r) => r.version)).toEqual([
      "Nightly 0.6.0-nightly.40",
      "v1.0.0",
    ]);
  });

  it("maps name→version (fallback tag), body→notes, date→YYYY-MM-DD", () => {
    const out = selectReleases([
      { tag_name: "v1.2.3", name: null, published_at: "2026-07-01T12:00:00Z", body: "notes here" },
    ]);
    expect(out[0]).toEqual({ version: "v1.2.3", date: "2026-07-01", notes: "notes here" });
  });

  it("tolerates missing/empty fields", () => {
    expect(selectReleases([{ tag_name: "v0.1.0" }])[0]).toEqual({
      version: "v0.1.0",
      date: "",
      notes: "",
    });
  });
});
