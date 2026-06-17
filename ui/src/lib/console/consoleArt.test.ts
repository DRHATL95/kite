import { describe, it, expect } from "vitest";
import { resolveConsoleModel, consoleTypeLabel } from "./consoleArt.js";

describe("resolveConsoleModel", () => {
  it("maps each known console type to its model key", () => {
    expect(resolveConsoleModel("XboxSeriesX")).toBe("seriesX");
    expect(resolveConsoleModel("XboxSeriesS")).toBe("seriesS");
    expect(resolveConsoleModel("XboxOne")).toBe("one");
    expect(resolveConsoleModel("XboxOneS")).toBe("oneS");
    expect(resolveConsoleModel("XboxOneX")).toBe("oneX");
  });

  it("falls back to 'generic' for unknown or empty types", () => {
    expect(resolveConsoleModel("XboxSeriesZ")).toBe("generic");
    expect(resolveConsoleModel("")).toBe("generic");
  });
});

describe("consoleTypeLabel", () => {
  it("returns friendly labels for known types", () => {
    expect(consoleTypeLabel("XboxSeriesX")).toBe("Xbox Series X");
    expect(consoleTypeLabel("XboxOneS")).toBe("Xbox One S");
  });

  it("returns the raw type for unknown values", () => {
    expect(consoleTypeLabel("XboxSeriesZ")).toBe("XboxSeriesZ");
  });
});
