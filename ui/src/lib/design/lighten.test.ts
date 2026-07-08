import { describe, it, expect } from "vitest";
import { lighten } from "./lighten.js";

describe("lighten", () => {
  it("returns the same color at amt 0 and white at amt 1", () => {
    expect(lighten("#36cfe8", 0)).toBe("#36cfe8");
    expect(lighten("#36cfe8", 1)).toBe("#ffffff");
  });

  it("mixes toward white by the given fraction (rounded per channel)", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    expect(lighten("#36cfe8", 0.3)).toBe("#72ddef");
  });
});
