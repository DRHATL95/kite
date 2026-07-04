// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const CHANNEL_KEY = "kite:update-channel";

beforeEach(() => {
  vi.resetModules();
});

// Import the fresh persist module post-resetModules and hydrate it. The
// subsequent settings import resolves to this same module instance.
async function seed(entries: [string, string][] = []) {
  const persist = await import("../persist/store.js");
  await persist.initPersistence({
    entries: async () => entries,
    set: async () => {},
  });
  return persist;
}

describe("settings store — updateChannel", () => {
  it("defaults to stable when nothing persisted", async () => {
    await seed();
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("stable");
  });

  it("persists and reflects a channel change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setChannel("nightly");
    expect(settings.updateChannel).toBe("nightly");
    expect(persist.persisted.getItem(CHANNEL_KEY)).toBe("nightly");
  });

  it("restores a persisted channel on load", async () => {
    await seed([[CHANNEL_KEY, "nightly"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("nightly");
  });

  it("normalises an unknown persisted value to stable", async () => {
    await seed([[CHANNEL_KEY, "garbage"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.updateChannel).toBe("stable");
  });
});

const AUDIO_ONLY_KEY = "kite:audio-only";

describe("settings store — audioOnly", () => {
  it("defaults to false when nothing persisted", async () => {
    await seed();
    const { settings } = await import("./settings.svelte.js");
    expect(settings.audioOnly).toBe(false);
  });

  it("persists and reflects an audio-only change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setAudioOnly(true);
    expect(settings.audioOnly).toBe(true);
    expect(persist.persisted.getItem(AUDIO_ONLY_KEY)).toBe("true");
  });

  it("restores a persisted audio-only=true on load", async () => {
    await seed([[AUDIO_ONLY_KEY, "true"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.audioOnly).toBe(true);
  });
});

const MINIMIZE_TO_TRAY_KEY = "kite:minimize-to-tray";

describe("settings store — minimizeToTray", () => {
  it("defaults to false when nothing persisted", async () => {
    await seed();
    const { settings } = await import("./settings.svelte.js");
    expect(settings.minimizeToTray).toBe(false);
  });

  it("persists and reflects a minimize-to-tray change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setMinimizeToTray(true);
    expect(settings.minimizeToTray).toBe(true);
    expect(persist.persisted.getItem(MINIMIZE_TO_TRAY_KEY)).toBe("true");
  });

  it("restores a persisted minimize-to-tray=true on load", async () => {
    await seed([[MINIMIZE_TO_TRAY_KEY, "true"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.minimizeToTray).toBe(true);
  });
});

const SHOW_HUD_KEY = "kite:show-diagnostics-hud";

describe("settings store — showDiagnosticsHud", () => {
  it("defaults ON for nightly when nothing persisted", async () => {
    await seed([[CHANNEL_KEY, "nightly"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.showDiagnosticsHud).toBe(true);
  });

  it("defaults OFF for stable when nothing persisted", async () => {
    await seed(); // no channel → stable
    const { settings } = await import("./settings.svelte.js");
    expect(settings.showDiagnosticsHud).toBe(false);
  });

  it("a persisted value overrides the channel default", async () => {
    await seed([
      [CHANNEL_KEY, "nightly"],
      [SHOW_HUD_KEY, "false"],
    ]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.showDiagnosticsHud).toBe(false);
  });

  it("persists and reflects a change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setShowDiagnosticsHud(true);
    expect(settings.showDiagnosticsHud).toBe(true);
    expect(persist.persisted.getItem(SHOW_HUD_KEY)).toBe("true");
  });
});

const STREAM_QUALITY_KEY = "kite:stream-quality";

describe("settings store — streamQuality", () => {
  it("defaults to auto when nothing persisted", async () => {
    await seed();
    const { settings } = await import("./settings.svelte.js");
    expect(settings.streamQuality).toBe("auto");
  });

  it("persists and reflects a quality change", async () => {
    const persist = await seed();
    const { settings } = await import("./settings.svelte.js");
    settings.setStreamQuality("medium");
    expect(settings.streamQuality).toBe("medium");
    expect(persist.persisted.getItem(STREAM_QUALITY_KEY)).toBe("medium");
  });

  it("restores a persisted quality on load", async () => {
    await seed([[STREAM_QUALITY_KEY, "low"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.streamQuality).toBe("low");
  });

  it("normalises an unknown persisted value to auto", async () => {
    await seed([[STREAM_QUALITY_KEY, "ultra"]]);
    const { settings } = await import("./settings.svelte.js");
    expect(settings.streamQuality).toBe("auto");
  });
});
