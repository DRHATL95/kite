// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom provides localStorage; clear between tests.
beforeEach(() => { localStorage.clear(); vi.resetModules(); });

describe("settings store — updateChannel", () => {
  it("defaults to stable when nothing persisted", async () => {
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("stable");
  });

  it("persists and reflects a channel change", async () => {
    const { settings } = await import("./settings.svelte.js");
    settings.setChannel("nightly");
    expect(settings.updateChannel).toBe("nightly");
    expect(localStorage.getItem("xbox-remote:update-channel")).toBe("nightly");
  });

  it("restores a persisted channel on load", async () => {
    localStorage.setItem("xbox-remote:update-channel", "nightly");
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("nightly");
  });

  it("normalises an unknown persisted value to stable", async () => {
    localStorage.setItem("xbox-remote:update-channel", "garbage");
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("stable");
  });
});
