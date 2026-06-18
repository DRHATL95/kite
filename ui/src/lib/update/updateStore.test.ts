// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./updater.js", () => ({
  checkForUpdate: vi.fn(),
  applyUpdate: vi.fn(),
}));

const CHANNEL_KEY = "xbox-remote:update-channel";

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function seed(entries: [string, string][] = []) {
  const persist = await import("../persist/store.js");
  await persist.initPersistence({
    entries: async () => entries,
    set: async () => {},
  });
  return persist;
}

describe("updateStore channel behavior", () => {
  it("checkOnLaunch uses the persisted channel, upgrade-only", async () => {
    await seed([[CHANNEL_KEY, "nightly"]]);
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue(null);
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.checkOnLaunch();
    expect(checkForUpdate).toHaveBeenCalledWith("nightly", false);
  });

  it("switchChannel persists the channel and checks it allowing downgrade", async () => {
    const persist = await seed();
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue({ version: "0.3.0", notes: "n" });
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.switchChannel("stable");
    expect(persist.persisted.getItem(CHANNEL_KEY)).toBe("stable");
    expect(checkForUpdate).toHaveBeenCalledWith("stable", true);
    expect(updateStore.available).toEqual({ version: "0.3.0", notes: "n" });
  });

  it("checkNow checks the persisted channel upgrade-only and surfaces an update", async () => {
    await seed([[CHANNEL_KEY, "nightly"]]);
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue({ version: "0.6.0-nightly.1" });
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.checkNow();
    expect(checkForUpdate).toHaveBeenCalledWith("nightly", false);
    expect(updateStore.available).toEqual({ version: "0.6.0-nightly.1" });
    expect(updateStore.upToDate).toBe(false);
    expect(updateStore.checking).toBe(false);
  });

  it("checkNow flags upToDate when nothing newer is found", async () => {
    await seed();
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue(null);
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.checkNow();
    expect(updateStore.available).toBeNull();
    expect(updateStore.upToDate).toBe(true);
    expect(updateStore.checking).toBe(false);
  });
});
