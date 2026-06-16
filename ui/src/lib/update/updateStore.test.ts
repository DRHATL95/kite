// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./updater.js", () => ({
  checkForUpdate: vi.fn(),
  applyUpdate: vi.fn(),
}));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.resetModules(); });

describe("updateStore channel behavior", () => {
  it("checkOnLaunch uses the persisted channel, upgrade-only", async () => {
    localStorage.setItem("xbox-remote:update-channel", "nightly");
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue(null);
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.checkOnLaunch();
    expect(checkForUpdate).toHaveBeenCalledWith("nightly", false);
  });

  it("switchChannel persists the channel and checks it allowing downgrade", async () => {
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue({ version: "0.3.0", notes: "n" });
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.switchChannel("stable");
    expect(localStorage.getItem("xbox-remote:update-channel")).toBe("stable");
    expect(checkForUpdate).toHaveBeenCalledWith("stable", true);
    expect(updateStore.available).toEqual({ version: "0.3.0", notes: "n" });
  });

  it("checkNow checks the persisted channel upgrade-only and surfaces an update", async () => {
    localStorage.setItem("xbox-remote:update-channel", "nightly");
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
    const { checkForUpdate } = await import("./updater.js");
    (checkForUpdate as any).mockResolvedValue(null);
    const { updateStore } = await import("./updateStore.svelte.js");
    await updateStore.checkNow();
    expect(updateStore.available).toBeNull();
    expect(updateStore.upToDate).toBe(true);
    expect(updateStore.checking).toBe(false);
  });
});
