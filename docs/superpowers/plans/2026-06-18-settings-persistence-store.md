# Settings Persistence (tauri-plugin-store) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make app settings (volume, clip prefs, update channel, theme) survive restarts by replacing the WebView `localStorage` backend with `tauri-plugin-store` behind a synchronous facade.

**Architecture:** A single adapter module (`ui/src/lib/persist/store.ts`) loads the store file once at startup, hydrates an in-memory snapshot, and exposes a synchronous `StorageLike` (`persisted`) with write-through persistence. Each store swaps `localStorage` → `persisted`; `main.ts` awaits `initPersistence()` then dynamically imports the stores/`App` so all synchronous reads hit a hydrated snapshot. No migration of old values.

**Tech Stack:** Tauri v2 (Rust), `tauri-plugin-store` 2.x, Svelte 5 runes, TypeScript, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-06-18-settings-persistence-store-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `ui/src/lib/persist/store.ts` | **new** — `persisted` facade, `initPersistence`, Tauri + test backends |
| `ui/src/lib/persist/store.test.ts` | **new** — adapter unit tests |
| `Cargo.toml` | add `tauri-plugin-store` dep |
| `src/main.rs` | register store plugin |
| `capabilities/default.json` | grant `store:default` |
| `ui/package.json` / `ui/pnpm-lock.yaml` | add `@tauri-apps/plugin-store` |
| `ui/src/lib/stores/theme.svelte.ts` | `localStorage` → `persisted` |
| `ui/src/lib/stores/settings.svelte.ts` | `localStorage` → `persisted` |
| `ui/src/components/StreamControls.svelte` | `localStorage` → `persisted` |
| `ui/src/main.ts` | await `initPersistence`, dynamic-import stores/App |
| `ui/src/lib/stores/settings.test.ts` | seed via `initPersistence` test backend |
| `ui/src/lib/update/updateStore.test.ts` | seed via `initPersistence` test backend |
| `ui/src/lib/settings/clipSettings.ts` | unchanged (already `StorageLike`) |

---

## Task 1: Persistence adapter + unit tests (TDD)

**Files:**
- Create: `ui/src/lib/persist/store.ts`
- Test: `ui/src/lib/persist/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/persist/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir ui run test -- --run src/lib/persist/store.test.ts`
Expected: FAIL — cannot resolve `./store.js` (module not found).

- [ ] **Step 3: Implement the adapter**

Create `ui/src/lib/persist/store.ts`:

```ts
/**
 * store.ts — durable settings persistence.
 *
 * tauri-plugin-store is async; our settings stores read synchronously at
 * construction. This adapter loads the store once at startup (initPersistence),
 * hydrates an in-memory snapshot, and exposes a synchronous StorageLike
 * (`persisted`) over it with write-through persistence. Swapping `localStorage`
 * for `persisted` is the only change each store needs.
 */

import type { StorageLike } from "../settings/clipSettings.js";

/** Minimal backend the adapter persists through (injectable for tests). */
export interface PersistBackend {
  entries(): Promise<[string, string][]>;
  set(key: string, value: string): Promise<void>;
}

const STORE_FILE = "settings.json";

const snapshot = new Map<string, string>();
let backend: PersistBackend | null = null;

/** Synchronous StorageLike over the hydrated snapshot, with write-through. */
export const persisted: StorageLike = {
  getItem(key: string): string | null {
    return snapshot.has(key) ? snapshot.get(key)! : null;
  },
  setItem(key: string, value: string): void {
    snapshot.set(key, value);
    // Fire-and-forget; the plugin debounces the actual disk save.
    void backend?.set(key, value);
  },
};

/** Build the real tauri-plugin-store backend (loaded lazily so tests/jsdom
 *  never need the Tauri runtime). */
async function createTauriBackend(): Promise<PersistBackend> {
  const { Store } = await import("@tauri-apps/plugin-store");
  const store = await Store.load(STORE_FILE);
  return {
    entries: () => store.entries() as Promise<[string, string][]>,
    set: (key, value) => store.set(key, value),
  };
}

/**
 * Load persisted settings into the snapshot. Call once before mount.
 * Falls back to an empty in-memory backend if the store can't load, so the
 * app still runs with defaults rather than crashing.
 */
export async function initPersistence(injected?: PersistBackend): Promise<void> {
  try {
    backend = injected ?? (await createTauriBackend());
    const entries = await backend.entries();
    snapshot.clear();
    for (const [k, v] of entries) snapshot.set(k, v);
  } catch (err) {
    console.warn("persistence init failed; using in-memory defaults", err);
    backend = null;
    snapshot.clear();
  }
}

/** Test seam: inject a backend (or null) and reset the snapshot. */
export function __setBackendForTests(b: PersistBackend | null): void {
  backend = b;
  snapshot.clear();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --dir ui run test -- --run src/lib/persist/store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Type-check**

Run: `pnpm --dir ui run check`
Expected: 0 errors. (`@tauri-apps/plugin-store` is imported only inside `createTauriBackend`; if `check` reports the module is missing, that dependency is added in Task 2 — re-run `check` after Task 2.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/persist/store.ts ui/src/lib/persist/store.test.ts
git commit -m "feat(ui): durable settings adapter over tauri-plugin-store"
```

---

## Task 2: Backend wiring (Cargo, plugin, capabilities, npm dep)

**Files:**
- Modify: `Cargo.toml`
- Modify: `src/main.rs`
- Modify: `capabilities/default.json`
- Modify: `ui/package.json`, `ui/pnpm-lock.yaml`

- [ ] **Step 1: Add the Rust crate**

In `Cargo.toml`, under `[dependencies]`, after the `tauri-plugin-opener = "2"` line, add:

```toml
tauri-plugin-store = "2"
```

- [ ] **Step 2: Register the plugin**

In `src/main.rs`, in the builder chain (currently lines 18–21), add the store plugin after `tauri_plugin_opener`:

```rust
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
```

- [ ] **Step 3: Grant the capability**

In `capabilities/default.json`, add `"store:default"` to the `permissions` array and update the description:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability: core, shell, updater, process, opener, store",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:default",
    "updater:default",
    "process:allow-restart",
    "opener:allow-reveal-item-in-dir",
    "store:default"
  ]
}
```

- [ ] **Step 4: Add the JS dependency (exact-pinned, matching repo convention)**

Run: `pnpm --dir ui add -E @tauri-apps/plugin-store`
(If `pnpm` is not on PATH: `corepack enable` first, or use `corepack pnpm@11.7.0 --dir ui add -E @tauri-apps/plugin-store`.)
Expected: `ui/package.json` gains an exact-pinned `@tauri-apps/plugin-store` under `dependencies`; `ui/pnpm-lock.yaml` updates.

- [ ] **Step 5: Verify Rust compiles and tests pass**

Run: `cargo test`
Expected: compiles; existing tests pass (no behavior change yet).

- [ ] **Step 6: Verify the frontend still type-checks with the new dep**

Run: `pnpm --dir ui run check`
Expected: 0 errors (the `@tauri-apps/plugin-store` import in `store.ts` now resolves).

- [ ] **Step 7: Commit**

```bash
git add Cargo.toml Cargo.lock src/main.rs capabilities/default.json ui/package.json ui/pnpm-lock.yaml
git commit -m "feat: register tauri-plugin-store (backend, capability, dep)"
```

---

## Task 3: Wire stores to `persisted` + bootstrap + update existing tests

This task changes the stores and their tests together so the suite stays green at commit.

**Files:**
- Modify: `ui/src/lib/stores/theme.svelte.ts`
- Modify: `ui/src/lib/stores/settings.svelte.ts`
- Modify: `ui/src/components/StreamControls.svelte`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/lib/stores/settings.test.ts`
- Modify: `ui/src/lib/update/updateStore.test.ts`

- [ ] **Step 1: Update `settings.test.ts` to seed via the adapter (red)**

Replace the entire contents of `ui/src/lib/stores/settings.test.ts` with:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const CHANNEL_KEY = "xbox-remote:update-channel";

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
```

- [ ] **Step 2: Update `updateStore.test.ts` to seed via the adapter (red)**

Replace the entire contents of `ui/src/lib/update/updateStore.test.ts` with:

```ts
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
```

- [ ] **Step 3: Run the two suites to verify they now fail (red)**

Run: `pnpm --dir ui run test -- --run src/lib/stores/settings.test.ts src/lib/update/updateStore.test.ts`
Expected: FAIL — stores still read `localStorage`, so seeded values aren't seen (e.g. "restores a persisted channel on load" gets `stable`).

- [ ] **Step 4: Swap `theme.svelte.ts` to `persisted`**

In `ui/src/lib/stores/theme.svelte.ts`:

Add the import after the existing `import { THEME_IDS, DEFAULT_THEME } ...` line:

```ts
import { persisted } from "../persist/store.js";
```

In `readInitial()`, change:

```ts
    const saved = localStorage.getItem(STORAGE_KEY);
```
to:
```ts
    const saved = persisted.getItem(STORAGE_KEY);
```

In `set()`, change:

```ts
      localStorage.setItem(STORAGE_KEY, id);
```
to:
```ts
      persisted.setItem(STORAGE_KEY, id);
```

- [ ] **Step 5: Swap `settings.svelte.ts` to `persisted`**

In `ui/src/lib/stores/settings.svelte.ts`:

Add the import after the `clipSettings` import block:

```ts
import { persisted } from "../persist/store.js";
```

In `readChannel()`, change `localStorage.getItem(CHANNEL_KEY)` → `persisted.getItem(CHANNEL_KEY)`.

In the `clip` field initialiser, change `loadClipSettings(localStorage)` → `loadClipSettings(persisted)`.

In `setChannel()`, change `localStorage.setItem(CHANNEL_KEY, c)` → `persisted.setItem(CHANNEL_KEY, c)`.

In `setClip()`, change `saveClipSettings(localStorage, this.clip)` → `saveClipSettings(persisted, this.clip)`.

- [ ] **Step 6: Swap `StreamControls.svelte` to `persisted`**

In `ui/src/components/StreamControls.svelte`, add to the `<script>` imports:

```ts
import { persisted } from "$lib/persist/store.js";
```

Then replace the three `localStorage` references (in `readSavedVolumePct()` at the `getItem`, in `applyVolume()` at the `setItem`, and in the `$effect` at the `getItem`):
- `localStorage.getItem(VOLUME_KEY)` → `persisted.getItem(VOLUME_KEY)` (both occurrences)
- `localStorage.setItem(VOLUME_KEY, String(pct / 100))` → `persisted.setItem(VOLUME_KEY, String(pct / 100))`

- [ ] **Step 7: Rewrite `main.ts` to preload then dynamically import**

Replace the entire contents of `ui/src/main.ts` with:

```ts
// Bundled fonts (offline-safe — Vite inlines the woff2 into ui/dist).
import "@fontsource/chakra-petch/500.css";
import "@fontsource/chakra-petch/600.css";
import "@fontsource/chakra-petch/700.css";
import "@fontsource-variable/hanken-grotesk/index.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";

import "./lib/design/tokens.css";
import { initPersistence } from "./lib/persist/store.js";

// Hydrate persisted settings BEFORE importing any store (whose synchronous
// construction reads settings) or mounting the app. Dynamic imports run after
// the await, so every read hits the hydrated snapshot — and the persisted
// theme is applied before first paint, avoiding a flash.
async function bootstrap(): Promise<void> {
  await initPersistence();

  const { themeStore } = await import("./lib/stores/theme.svelte.js");
  themeStore.init();

  const { mount } = await import("svelte");
  const { default: App } = await import("./App.svelte");
  mount(App, { target: document.getElementById("app")! });
}

void bootstrap();
```

- [ ] **Step 8: Run the two updated suites to verify they pass (green)**

Run: `pnpm --dir ui run test -- --run src/lib/stores/settings.test.ts src/lib/update/updateStore.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full frontend test suite + type-check**

Run: `pnpm --dir ui run test -- --run`
Expected: all suites PASS (including `store.test.ts` from Task 1).

Run: `pnpm --dir ui run check`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add ui/src/lib/stores/theme.svelte.ts ui/src/lib/stores/settings.svelte.ts ui/src/components/StreamControls.svelte ui/src/main.ts ui/src/lib/stores/settings.test.ts ui/src/lib/update/updateStore.test.ts
git commit -m "feat(ui): persist settings through tauri-plugin-store adapter"
```

---

## Task 4: Full verification + finish

**Files:** none (verification only)

- [ ] **Step 1: Full frontend gates**

Run: `pnpm --dir ui run check`
Expected: 0 errors.

Run: `pnpm --dir ui run test -- --run`
Expected: all suites PASS.

- [ ] **Step 2: Rust gate**

Run: `cargo test`
Expected: PASS.

- [ ] **Step 3: Build the embedded frontend + run smoke**

Run:
```bash
pnpm --dir ui run build
cargo clean -p xbox-remote
cargo run
```
Expected: app launches. Manually: change theme/volume/channel/clip toggle, fully quit, relaunch → settings are retained. (`cargo clean -p` is required so Tauri re-embeds the rebuilt `ui/dist` — see CLAUDE.md.)

- [ ] **Step 4: Confirm the store file is written**

After step 3, confirm `settings.json` exists under the app config dir
(`%APPDATA%\com.xboxremote.app\settings.json` on Windows) and contains the
changed keys.

- [ ] **Step 5: Finish the branch**

Announce and use superpowers:finishing-a-development-branch (tests already verified) → push + open PR.
