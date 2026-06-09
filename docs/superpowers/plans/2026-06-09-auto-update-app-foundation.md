# Auto-Update — App-Side Foundation (Sub-project 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the installed app updater-capable — integrate `tauri-plugin-updater` + `tauri-plugin-process`, a signing keypair, the AppImage/NSIS bundle + updater config, and an in-app "check on launch → prompt → install" UI in the Carbon+Green style.

**Architecture:** The JS updater API (`@tauri-apps/plugin-updater`) checks a Gitea-hosted `latest.json` on launch; a small Svelte store + banner surfaces an available update; on approval it downloads the *signed* artifact, verifies it against the embedded public key, installs, and relaunches via `@tauri-apps/plugin-process`. CI (sub-project 2) signs artifacts and publishes the manifest; this sub-project makes the app able to consume them.

**Tech Stack:** Tauri 2 updater/process plugins, Rust, Svelte 5 + TS, Vite.

**Reference:** Spec `docs/superpowers/specs/2026-06-09-auto-update-cicd-design.md` §3. Repo is **public** so the updater needs no auth. Updater endpoint (nightly channel): `https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/latest.json`.

**Branch:** `auto-update-cicd` (checked out; spec committed here).

**Git rule (all tasks):** explicit staging only (tree has unrelated noise: `gen/schemas/*.json` churn, `.claude/`, `*.sh`). Never `git add -A`. The **updater private key must NEVER be committed.**

---

## Task 1: Add updater + process plugins (Rust + JS + capability)

**Files:** `Cargo.toml`, `src/main.rs`, `ui/package.json`, new `capabilities/default.json`.

- [ ] **Step 1: Add Rust deps** to `Cargo.toml` `[dependencies]`:
```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```
- [ ] **Step 2: Register the plugins** in `src/main.rs` on the `tauri::Builder` chain (next to the existing `.plugin(tauri_plugin_shell::init())`):
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
```
- [ ] **Step 3: Add JS deps**: `npm --prefix ui install @tauri-apps/plugin-updater @tauri-apps/plugin-process`.
- [ ] **Step 4: Grant permissions via a capability.** First check the current state: `cat tauri.conf.json` (is `app.security.capabilities` set?) and `ls capabilities/ 2>/dev/null`. The app's own `#[tauri::command]`s don't need a capability, but the updater/process PLUGINS do. Create `capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capability: core, shell, updater, process",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:default",
    "updater:default",
    "process:allow-restart"
  ]
}
```
Tauri auto-loads `capabilities/*.json` from the config dir. If adding this changes runtime behavior (it shouldn't — `core:default` is permissive), verify the app still launches + streams. The main window label is `main` (default, since `tauri.conf.json` `app.windows[0]` has no explicit label).
- [ ] **Step 5: Build** — `cargo build` → `Finished`. (Plugin registration + capability compile.) Run `cargo run` to confirm the app still launches + sign-in works (existing commands unaffected). Then close it.
- [ ] **Step 6: Commit**: `git add Cargo.toml src/main.rs ui/package.json ui/package-lock.json capabilities/default.json && git commit -m "feat(update): add updater + process plugins and capability"`

---

## Task 2: Signing keypair + updater/bundle config

**Files:** `tauri.conf.json`. **Secret artifact (NOT committed):** the updater private key.

- [ ] **Step 1: Generate the signing keypair.** Run `cargo tauri signer generate -w "$HOME/.tauri/xbox-remote-updater.key"` (writes the private key to that path OUTSIDE the repo, prints the **public key**). The command prints the public key and the private key path. **Do NOT print or commit the private key.** Record only the PUBLIC key for the next step. (The private key + its password go to a Gitea Actions secret in sub-project 2; also back it up — losing it breaks all future updates.)
- [ ] **Step 2: Configure the updater + bundle** in `tauri.conf.json`. Set `bundle.targets` to include appimage, enable updater artifacts, and add the `plugins.updater` block:
```json
"bundle": {
  "active": true,
  "targets": ["nsis", "appimage"],
  "createUpdaterArtifacts": true,
  "icon": ["icons/icon.ico", "icons/icon.png"],
  "windows": { "...keep existing nsis/webview config..." }
},
"plugins": {
  "updater": {
    "endpoints": ["https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/latest.json"],
    "pubkey": "<PASTE THE PUBLIC KEY FROM STEP 1>"
  }
}
```
(Keep all existing `bundle.windows` settings. `plugins` is a new top-level key in tauri.conf.json.)
- [ ] **Step 3: Validate** — `node -e "JSON.parse(require('fs').readFileSync('tauri.conf.json','utf8'));console.log('valid')"` → `valid`. Confirm the private key path is in `.gitignore`-safe territory (it's outside the repo at `~/.tauri/`, so not trackable).
- [ ] **Step 4: Build** — `cargo build` → `Finished` (the updater config compiles). Full bundle verification is in Task 5.
- [ ] **Step 5: Commit**: `git add tauri.conf.json && git commit -m "feat(update): updater config (pubkey + endpoint) + appimage target + updater artifacts"`
  (Confirm `git show --stat HEAD` is ONLY `tauri.conf.json` — the private key must not appear.)

---

## Task 3: Frontend updater module + store

**Files:** Create `ui/src/lib/update/updater.ts`, `ui/src/lib/update/updateStore.svelte.ts`.

- [ ] **Step 1: `updater.ts`** — thin typed wrapper over the plugin API:
```ts
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateInfo = { version: string; notes?: string };

/** Check for an update. Returns the pending Update or null. Never throws to the caller. */
export async function checkForUpdate(): Promise<Update | null> {
  try { return await check(); } catch { return null; }
}

/** Download + install with progress, then relaunch. */
export async function applyUpdate(update: Update, onProgress?: (pct: number) => void): Promise<void> {
  let total = 0, got = 0;
  await update.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") { got += e.data.chunkLength; if (total) onProgress?.(Math.round((got / total) * 100)); }
  });
  await relaunch();
}
```
- [ ] **Step 2: `updateStore.svelte.ts`** — Svelte 5 rune store driving the banner:
```ts
import { checkForUpdate, applyUpdate } from "./updater";
import type { Update } from "@tauri-apps/plugin-updater";

class UpdateStore {
  available = $state<{ version: string; notes?: string } | null>(null);
  installing = $state(false);
  progress = $state(0);
  error = $state<string | null>(null);
  #pending: Update | null = null;

  async checkOnLaunch() {
    const u = await checkForUpdate();
    if (u) { this.#pending = u; this.available = { version: u.version, notes: u.body ?? undefined }; }
  }
  async install() {
    if (!this.#pending) return;
    this.installing = true; this.error = null;
    try { await applyUpdate(this.#pending, (p) => (this.progress = p)); }
    catch (e) { this.error = String(e); this.installing = false; }
  }
  dismiss() { this.available = null; }
}
export const updateStore = new UpdateStore();
```
- [ ] **Step 3: Typecheck** — `npm --prefix ui run check` → 0 errors. (The plugin types resolve.)
- [ ] **Step 4: Commit**: `git add ui/src/lib/update && git commit -m "feat(update): frontend updater wrapper + rune store"`

---

## Task 4: Update banner UI + wire check-on-launch

**Files:** Create `ui/src/components/UpdateBanner.svelte`; modify `ui/src/App.svelte`.

- [ ] **Step 1: `UpdateBanner.svelte`** — Carbon+Green, unobtrusive top banner driven by `updateStore`. Shows "Update available — v{version}" with an Install `Button` (primary) + a dismiss (ghost); while installing, a progress bar (accent fill) + percent; errors in `--bad`. Hidden when `available` is null. Use `$lib/design` tokens + `Button`. (No new tokens; reuse the palette.)
- [ ] **Step 2: Wire check-on-launch** in `ui/src/App.svelte`: in the existing `onMount`, after `authStore.loadCached()`, call `updateStore.checkOnLaunch()` (fire-and-forget; it never throws). Render `<UpdateBanner />` at the top of the app shell (above the routed screen) so it's visible on every screen.
- [ ] **Step 3: Verify render** — `npm --prefix ui run check` (0 errors) + `npm --prefix ui run build`. Visual: temporarily set `updateStore.available = { version: "0.1.99" }` (or a mock) and screenshot via `npm run dev` to confirm the banner renders in the Carbon+Green style; revert the mock.
- [ ] **Step 4: Commit**: `git add ui/src/components/UpdateBanner.svelte ui/src/App.svelte && git commit -m "feat(update): in-app update banner + check on launch"`

---

## Task 5: Full build verification (installer + updater artifacts)

- [ ] **Step 1: Build the installer + updater artifacts** — `npm --prefix ui run build` then `cargo tauri build`. Expected: the NSIS installer in `target/release/bundle/nsis/`, AND the **updater artifacts** (`*.nsis.zip` + a `*.nsis.zip.sig` signature file) in the bundle dir (because `createUpdaterArtifacts: true`). Confirm the `.sig` file exists (proves signing works).
- [ ] **Step 2: Confirm signing** — `find target/release/bundle -name "*.sig"` returns the signature file(s). (Linux/AppImage artifacts build in CI; here we verify the Windows updater artifact + signature.)
- [ ] **Step 3: Verify no secret leaked** — `git grep -i "untrusted comment\|PRIVATE KEY\|minisign" -- . ':!docs'` returns nothing in tracked files; the private key lives only at `~/.tauri/`.
- [ ] **Step 4: Final checks** — `npm --prefix ui run check` (0 errors), `npm --prefix ui run test` (pass), `cargo build` (Finished).
- [ ] **Step 5: Commit any remaining + summarize** (no code change expected here; this task is verification).

---

## Final verification (sub-project 1)
- [ ] `cargo tauri build` produces the NSIS installer **and** signed updater artifacts (`.nsis.zip` + `.sig`).
- [ ] Updater + process plugins registered; `capabilities/default.json` grants `updater:default` + `process:allow-restart`; app still launches + streams.
- [ ] `tauri.conf.json` has the updater endpoint (nightly `latest.json`) + the **public** key; bundle targets `nsis` + `appimage`; `createUpdaterArtifacts: true`.
- [ ] The Svelte update banner renders (mock) in Carbon+Green; `checkOnLaunch()` is wired into `App.svelte` `onMount`.
- [ ] **The private key is NOT in the repo** (`git grep` clean; key at `~/.tauri/`).
- [ ] `npm run check`/`test` + `cargo build` pass.

> Note: the *end-to-end* update (a real download+install from Gitea) can't be tested until sub-projects 2 (workflow publishes `latest.json` + signed artifacts) and 3 (runners) exist. This sub-project delivers an app that is *ready* to update and a Windows installer that *emits* signed updater artifacts.
