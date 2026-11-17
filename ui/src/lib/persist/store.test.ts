import { describe, it, expect, beforeEach } from "vitest";
import {
  persisted,
  initPersistence,
  __setBackendForTests,
  type PersistBackend,
} from "./store.js";

function memBackend(initial: [string, string][] = []) {
  const saved = new Map<string, string>(initial);
  const backend: PersistBackend = {
    entries: async () => [...saved.entries()],
    set: async (k, v) => {
      saved.set(k, v);
    },
    delete: async (k) => {
      saved.delete(k);
    },
  };
  return { backend, saved };
}

beforeEach(() => {
  __setBackendForTests(null);
});

describe("persisted adapter", () => {
  it("getItem returns null before hydration", () => {
    expect(persisted.getItem("missing")).toBeNull();
  });

  it("initPersistence hydrates the snapshot from the backend", async () => {
    await initPersistence(memBackend([["k", "v"]]).backend);
    expect(persisted.getItem("k")).toBe("v");
  });

  it("setItem updates the snapshot synchronously", async () => {
    await initPersistence(memBackend().backend);
    persisted.setItem("a", "1");
    expect(persisted.getItem("a")).toBe("1");
  });

  it("setItem writes through to the backend", async () => {
    const { backend, saved } = memBackend();
    await initPersistence(backend);
    persisted.setItem("a", "1");
    await Promise.resolve(); // flush the fire-and-forget write
    expect(saved.get("a")).toBe("1");
  });

  it("migrates a legacy rebrand key on init and drops it from the backend", async () => {
    const { backend, saved } = memBackend([["xbox-remote-theme", "midnight"]]);
    await initPersistence(backend);
    await Promise.resolve(); // flush the fire-and-forget write-through

    // snapshot exposes the new key, not the legacy one
    expect(persisted.getItem("kite-theme")).toBe("midnight");
    expect(persisted.getItem("xbox-remote-theme")).toBeNull();
    // backend was rewritten: new key persisted, legacy key deleted
    expect(saved.get("kite-theme")).toBe("midnight");
    expect(saved.has("xbox-remote-theme")).toBe(false);
  });

  it("survives a backend that throws on init (in-memory fallback, no crash)", async () => {
    const bad: PersistBackend = {
      entries: async () => {
        throw new Error("boom");
      },
      set: async () => {},
    };
    await initPersistence(bad);
    expect(persisted.getItem("anything")).toBeNull();
    persisted.setItem("x", "y");
    expect(persisted.getItem("x")).toBe("y");
  });
});
