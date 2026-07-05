import { describe, it, expect } from "vitest";
import { SETTINGS_CATEGORIES, DEFAULT_CATEGORY, isValidCategory } from "./settingsNav.js";

describe("settingsNav", () => {
  it("lists the seven categories in display order", () => {
    expect(SETTINGS_CATEGORIES.map((c) => c.id)).toEqual([
      "streaming",
      "controller",
      "general",
      "updates",
      "advanced",
      "account",
      "about",
    ]);
  });

  it("defaults to general, which is a real category", () => {
    expect(DEFAULT_CATEGORY).toBe("general");
    expect(isValidCategory(DEFAULT_CATEGORY)).toBe(true);
  });

  it("accepts every category id and rejects unknown/empty ids", () => {
    for (const c of SETTINGS_CATEGORIES) expect(isValidCategory(c.id)).toBe(true);
    expect(isValidCategory("bogus")).toBe(false);
    expect(isValidCategory("")).toBe(false);
  });
});
