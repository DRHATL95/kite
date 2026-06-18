# Settings Persistence via tauri-plugin-store — Design

**Date:** 2026-06-18
**Status:** Approved (design), pending implementation
**Author:** David Howard (with Claude)

## Problem

App settings do not survive a restart. Volume, clipping preferences, the
auto-update channel (stable/nightly), and theme all reset to defaults every time
the app is relaunched.

### Root cause

All four settings persist through the WebView's `localStorage`:

| Setting | Location | Key |
|---|---|---|
| Volume | `ui/src/components/StreamControls.svelte` | `xbox-remote-volume` |
| Update channel | `ui/src/lib/stores/settings.svelte.ts` | `xbox-remote:update-channel` |
| Clipping prefs | `ui/src/lib/settings/clipSettings.ts` (via `settings.svelte.ts`) | `xbox-remote-clip-settings` |
| Theme | `ui/src/lib/stores/theme.svelte.ts` | `xbox-remote-theme` |

Investigation confirmed:

- No application code clears storage on startup (`localStorage.clear()` appears
  only in test setup).
- The Rust side uses the default WebView storage — no custom data directory,
  incognito mode, or `additional_browser_args`; no store plugin is registered.
- The read/write logic in each store is correct.

That leaves the persistence layer itself. On WebView2 (Chromium), `localStorage`
mutations are held in memory and committed to disk on a delay or on a clean
WebView shutdown. When the host process tears down before that flush — common on
Windows app exit — the writes are lost. `localStorage` is therefore an
unreliable foundation for app settings in a Tauri app.

## Goal

Persist all app settings to a durable on-disk store so they survive restarts,
while keeping the existing store code and its testability essentially unchanged.

## Decision

Use the official **`tauri-plugin-store`** (v2). It writes a JSON file in the app
config directory through the Rust backend — an ordinary, immediate OS file write
that is not subject to Chromium's `localStorage` flush timing.

**Existing settings are NOT migrated.** Because `localStorage` was already
unreliable, there is rarely anything meaningful to carry over. On first launch of
the new build every store falls back to its current defaults, then persists
durably from then on. The one user-visible consequence: a nightly-channel tester
is reset to `stable` once and must re-toggle nightly.

## Approach

**Async preload + synchronous facade.** `tauri-plugin-store`'s API is async; our
stores read synchronously at construction. Rather than make every store async
(and introduce a theme flash and broad churn), we:

1. Load the store file **once at startup, before mount**, and hydrate an
   in-memory snapshot.
2. Expose a `{ getItem, setItem }` object (`persisted`) that reads the snapshot
   synchronously and write-through-persists on `setItem`.
3. Swap each call site from `localStorage` to `persisted` — a one-identifier
   change. The pure `clipSettings.ts` already takes a `StorageLike`, so it
   changes zero lines.

This isolates all async/Tauri specifics behind one small adapter and leaves the
rest of the app's logic intact.

## Architecture

### New module: `ui/src/lib/persist/store.ts`

Owns all `tauri-plugin-store` contact. Exports:

- **`persisted: StorageLike`** — `{ getItem, setItem }` over an in-memory
  `Map<string, string>`.
  - `getItem(key)` → snapshot value or `null` (synchronous).
  - `setItem(key, value)` → update snapshot synchronously, then write through to
    the backend (fire-and-forget; debounced so rapid updates such as a volume
    drag coalesce into a single file write).
- **`initPersistence(backend?): Promise<void>`** — called once in `main.ts`
  before mount. Resolves the backend (default = real Tauri backend), clears and
  rehydrates the snapshot from `backend.entries()`.
- **`__setBackendForTests(backend | null): void`** — test seam to inject an
  in-memory backend and reset the snapshot.

Backend interface (the injectable seam that keeps the adapter testable without a
Tauri runtime):

```ts
interface PersistBackend {
  entries(): Promise<[string, string][]>;     // hydrate
  set(key: string, value: string): Promise<void>; // persist one key (impl saves)
}
```

- **Real backend** (`createTauriBackend`) wraps
  `Store.load('settings.json')`: `entries()` → `store.entries()`; `set()` →
  `store.set(key, value)` (plugin persists), with a small debounce on the
  underlying save so volume-slider drags don't thrash the disk.
- **In-memory backend** — a plain `Map`, used by unit tests.

The `StorageLike` interface already exists in `ui/src/lib/settings/clipSettings.ts`
and is reused (`{ getItem(key): string|null; setItem(key, value): void }`). All
values stored are strings, matching the existing contract (volume = number-as
string, channel/theme = plain strings, clip = `JSON.stringify`'d), so callers are
unchanged beyond the identifier swap.

### Call-site changes (logic unchanged)

- `ui/src/lib/stores/theme.svelte.ts` — `localStorage.*` → `persisted.*`.
- `ui/src/lib/stores/settings.svelte.ts` — `localStorage.*` → `persisted.*`;
  pass `persisted` (not `localStorage`) into `loadClipSettings`/`saveClipSettings`.
- `ui/src/components/StreamControls.svelte` — `localStorage.*` → `persisted.*`.
- `ui/src/lib/settings/clipSettings.ts` — **no change** (already `StorageLike`).

### Startup ordering: `ui/src/main.ts`

ES `import` runs a module's top-level code before the importer's body, so a
static `import { themeStore }` would construct the store (and read persistence)
before we can `await` hydration. To guarantee every synchronous read hits a
hydrated snapshot, `main.ts` awaits `initPersistence()` first, then **dynamically
imports** the store modules and `App`:

```ts
import "./fonts…";
import "./lib/design/tokens.css";
import { initPersistence } from "./lib/persist/store";

async function bootstrap() {
  await initPersistence();                                   // hydrate snapshot
  const { themeStore } = await import("./lib/stores/theme.svelte.js");
  themeStore.init();                                         // theme before paint
  const { mount } = await import("svelte");
  const { default: App } = await import("./App.svelte");
  mount(App, { target: document.getElementById("app")! });
}
void bootstrap();
```

An async bootstrap function (not top-level `await`) is used to avoid any build
target concerns with top-level await.

### Backend wiring

- `Cargo.toml` — add `tauri-plugin-store = "2"`.
- `src/main.rs` — register `.plugin(tauri_plugin_store::Builder::default().build())`.
- `capabilities/default.json` — add `"store:default"` to `permissions`.
- `ui/package.json` — add `@tauri-apps/plugin-store`; `pnpm install`.

## Data flow

```
launch
  └─ main.ts: await initPersistence()
        └─ Store.load('settings.json') → entries() → snapshot Map
  └─ dynamic import stores/App (construct; synchronous reads hit snapshot)
        └─ getItem(key) → snapshot value or default
user changes a setting
  └─ persisted.setItem(key, value)
        ├─ snapshot.set(key, value)            (immediate, reactive)
        └─ backend.set(key, value) → store.set → durable file write (debounced)
next launch → settings.json read back → values restored
```

## Error handling

- If `Store.load` fails, `initPersistence` logs a warning and falls back to the
  in-memory backend: the app runs with defaults and never crashes — equivalent to
  today's "localStorage unavailable" branch, minus the data loss.
- In a non-Tauri context (Vitest/jsdom), tests inject the in-memory backend via
  `__setBackendForTests`; `initPersistence` is not called.

## Testing

- **Pure logic** (`validateClipSettings`, etc.) — unchanged, still covered.
- **Adapter** (`ui/src/lib/persist/store.test.ts`) — new unit tests against a
  fake backend: hydrate from `entries()`, `getItem` returns hydrated/`null`,
  `setItem` updates snapshot synchronously and calls `backend.set`, fallback when
  no backend.
- **Existing tests** (`settings.test.ts`, `updateStore.test.ts`) — switch from
  `localStorage.*` / `localStorage.clear()` to seeding/resetting `persisted` via
  `__setBackendForTests` (in-memory).
- **Gates:** `pnpm run check`, `pnpm run test`, `cargo test` all green; a release
  frontend build + `cargo clean -p xbox-remote && cargo run` smoke; final manual
  confirmation by the user (set a value → restart → it sticks).

## Out of scope

- Migrating existing `localStorage` values (explicitly declined).
- A settings-export/import feature.
- Multi-window store sync (single-window app).
- Moving auth/token storage (already in the OS keychain; unaffected).

## Files

| File | Change |
|---|---|
| `ui/src/lib/persist/store.ts` | **new** — adapter (`persisted`, `initPersistence`, backends) |
| `ui/src/lib/persist/store.test.ts` | **new** — adapter unit tests |
| `ui/src/main.ts` | await `initPersistence`, dynamic import stores/App |
| `ui/src/lib/stores/theme.svelte.ts` | `localStorage` → `persisted` |
| `ui/src/lib/stores/settings.svelte.ts` | `localStorage` → `persisted` |
| `ui/src/components/StreamControls.svelte` | `localStorage` → `persisted` |
| `ui/src/lib/stores/settings.test.ts` | reset/seed via `__setBackendForTests` |
| `ui/src/lib/update/updateStore.test.ts` | reset/seed via `__setBackendForTests` |
| `ui/package.json` | add `@tauri-apps/plugin-store` |
| `Cargo.toml` | add `tauri-plugin-store = "2"` |
| `src/main.rs` | register store plugin |
| `capabilities/default.json` | add `store:default` |
| `ui/src/lib/settings/clipSettings.ts` | unchanged (already `StorageLike`) |
