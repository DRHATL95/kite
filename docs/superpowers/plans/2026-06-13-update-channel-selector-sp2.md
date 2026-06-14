# Update Channel Selector — SP2 Implementation Plan

> **For agentic workers:** This plan is executed by an **agent team**. Tasks are grouped into two ownership tracks (Rust / Frontend) that run in parallel against a fixed command contract, plus integration tasks owned by the lead. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let users pick Stable or Nightly updates from Settings (default Stable), with the launch check upgrade-only and an explicit channel switch allowed to downgrade.

**Architecture:** Channel selection requires `app.updater_builder().endpoints([...])` (Rust), so update **check + install move to Rust commands**; the JS layer becomes a thin caller. A persisted `settings` store holds the channel; `SettingsModal` exposes a toggle.

**Tech Stack:** Rust/Tauri 2 (`tauri-plugin-updater`, `tauri-plugin-process`), Svelte 5 runes, Vitest, `cargo test`.

**Spec:** [docs/superpowers/specs/2026-06-13-update-channel-selector-sp2-design.md](../specs/2026-06-13-update-channel-selector-sp2-design.md)

---

## Command contract (fixed — both tracks code against this)

Two Tauri commands (snake_case names; JS `invoke` uses the same names):

- `check_update(channel: String, allow_downgrade: bool) -> Result<Option<UpdateMeta>, String>`
  where `UpdateMeta { version: String, current_version: String, notes: Option<String> }`
  (serialized camelCase: `version`, `currentVersion`, `notes`). Returns `Ok(None)` when no
  update; `Err(String)` on failure (JS wrapper swallows → silent no-op).
- `install_update(on_event: Channel<DownloadEvent>) -> Result<(), String>`
  where `DownloadEvent` is a serde-tagged enum: `{ event: "Started", data: { contentLength } }`,
  `{ event: "Progress", data: { chunkLength } }`, `{ event: "Finished" }`. Relaunches on success.

## File ownership (for the team)

| Track | Owns | Tasks |
|---|---|---|
| **Rust** | `src/updater.rs` (new), `src/main.rs`, `tauri.conf.json`, `capabilities/default.json` | 2, 3, 6 |
| **Frontend** | `ui/src/lib/stores/settings.svelte.ts` (new), `ui/src/lib/update/updater.ts`, `ui/src/lib/update/updateStore.svelte.ts`, `ui/src/components/SettingsModal.svelte` | 1, 4, 5 |
| **Lead** | docs + integration build/run | 7, 8 |

Tracks 1 (settings store) and 2 (Rust helper) start immediately in parallel. Frontend Tasks 4→5→6 are sequential within the track; Rust 2→3 sequential. No file is owned by two tracks.

---

## Task 1: Settings store (Frontend track)

**Files:** Create `ui/src/lib/stores/settings.svelte.ts`; Test `ui/src/lib/stores/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/stores/settings.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it — expect FAIL** (`npm --prefix ui run test -- settings`) — module missing.

- [ ] **Step 3: Implement**

Create `ui/src/lib/stores/settings.svelte.ts` (mirrors `theme.svelte.ts` persistence):

```ts
/**
 * settings.svelte.ts — small persisted app settings (Svelte 5 runes).
 * Currently: the auto-update channel (stable | nightly), default stable.
 */

export type UpdateChannel = "stable" | "nightly";

const CHANNEL_KEY = "xbox-remote:update-channel";
const DEFAULT_CHANNEL: UpdateChannel = "stable";

function readChannel(): UpdateChannel {
  try {
    const saved = localStorage.getItem(CHANNEL_KEY);
    if (saved === "stable" || saved === "nightly") return saved;
  } catch {
    // localStorage unavailable — use default
  }
  return DEFAULT_CHANNEL;
}

class SettingsStore {
  /** Active auto-update channel (reactive). */
  updateChannel: UpdateChannel = $state(readChannel());

  /** Switch channel and persist it. */
  setChannel(c: UpdateChannel): void {
    this.updateChannel = c;
    try {
      localStorage.setItem(CHANNEL_KEY, c);
    } catch {
      // best-effort persistence
    }
  }
}

export const settings = new SettingsStore();
```

- [ ] **Step 4: Run it — expect PASS** (`npm --prefix ui run test -- settings`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/stores/settings.svelte.ts ui/src/lib/stores/settings.test.ts
git commit -m "feat(settings): persisted update-channel store (default stable)"
```

---

## Task 2: Rust channel→endpoint helper (Rust track)

**Files:** Create `src/updater.rs`; test inline (`#[cfg(test)]` in the same file).

- [ ] **Step 1: Write the failing test + helper skeleton**

Create `src/updater.rs`:

```rust
//! In-app update channel support: maps the selected channel to its rolling
//! latest.json endpoint and runs the check/install against it. See
//! docs/superpowers/specs/2026-06-13-update-channel-selector-sp2-design.md

/// Map a channel name to its rolling latest.json endpoint URL.
/// Unknown values fall back to the stable channel (safe default).
pub fn channel_endpoint(channel: &str) -> String {
    let ch = if channel == "nightly" { "nightly" } else { "stable" };
    format!("https://gitea.howlab.co/dave/xbox-remote/releases/download/{ch}/latest.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_channels() {
        assert!(channel_endpoint("stable").ends_with("/download/stable/latest.json"));
        assert!(channel_endpoint("nightly").ends_with("/download/nightly/latest.json"));
    }

    #[test]
    fn unknown_channel_falls_back_to_stable() {
        assert!(channel_endpoint("garbage").ends_with("/download/stable/latest.json"));
        assert!(channel_endpoint("").ends_with("/download/stable/latest.json"));
    }
}
```

- [ ] **Step 2: Wire the module so it compiles**

In `src/main.rs`, add after the other `mod` lines (currently `mod auth; mod error; mod token_store; mod xhome;`):

```rust
mod updater;
```

- [ ] **Step 3: Run the test — expect PASS** (`cargo test channel_endpoint` then `cargo test updater::`).

Run: `cargo test updater 2>&1 | tail -15`
Expected: the two `updater::tests::*` pass.

- [ ] **Step 4: Commit**

```bash
git add src/updater.rs src/main.rs
git commit -m "feat(updater): channel_endpoint helper + module scaffold"
```

---

## Task 3: Rust check/install commands (Rust track)

**Files:** Modify `src/updater.rs` (add commands + state), `src/main.rs` (register state + commands).

- [ ] **Step 1: Add the commands + state to `src/updater.rs`**

Append to `src/updater.rs` (above the `#[cfg(test)]` block):

```rust
use std::sync::Mutex;
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Holds the pending update between `check_update` and `install_update`.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMeta {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

/// Progress events streamed to the frontend during install.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// Check the selected channel for an update. `allow_downgrade=true` (explicit
/// channel switch) accepts any version that differs from the current one;
/// otherwise only a strictly-newer version qualifies. Returns None when there's
/// nothing to offer. Errors are returned as strings (the JS wrapper no-ops).
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    channel: String,
    allow_downgrade: bool,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMeta>, String> {
    let endpoint = channel_endpoint(&channel)
        .parse()
        .map_err(|e| format!("bad endpoint url: {e}"))?;

    let mut builder = app.updater_builder().endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?;
    if allow_downgrade {
        builder = builder.version_comparator(|current, update| update.version != current);
    }
    let updater = builder.build().map_err(|e| e.to_string())?;

    let maybe = updater.check().await.map_err(|e| e.to_string())?;
    let meta = maybe.as_ref().map(|u| UpdateMeta {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().unwrap() = maybe;
    Ok(meta)
}

/// Download + install the pending update (streaming progress), then relaunch.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    on_event: Channel<DownloadEvent>,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take()
        .ok_or_else(|| "no pending update".to_string())?;

    let mut started = false;
    update
        .download_and_install(
            |chunk, total| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length: total });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length: chunk });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
}
```

NOTE for the implementer: `app.restart()` is `-> !` (never returns) in Tauri 2, so it is the final expression with no trailing `Ok(())`. If the installed `tauri-plugin-updater` version exposes the `Update` fields or `version_comparator`/`download_and_install` closures with slightly different signatures, adjust to match the compiler (the shapes above match tauri-plugin-updater 2.x as used by this project). Keep `UpdateMeta`/`DownloadEvent` serde shapes exactly as written — the frontend depends on them.

- [ ] **Step 2: Register state + commands in `src/main.rs`**

In the `.setup(|app| { ... })` block, after `app.manage(tauri_commands::AppState { ... });`, add:

```rust
            app.manage(updater::PendingUpdate::default());
```

In `tauri::generate_handler![ ... ]`, add these two entries (after `send_session_keepalive,`):

```rust
            updater::check_update,
            updater::install_update,
```

- [ ] **Step 3: Compile**

Run: `cargo build 2>&1 | tail -20`
Expected: builds (warnings OK). If `version_comparator` / `download_and_install` signatures differ, fix per the compiler, preserving behavior.

- [ ] **Step 4: Run Rust tests**

Run: `cargo test 2>&1 | tail -15`
Expected: existing tests + `updater::tests` pass.

- [ ] **Step 5: Commit**

```bash
git add src/updater.rs src/main.rs
git commit -m "feat(updater): check_update/install_update commands with channel endpoints"
```

---

## Task 4: Frontend updater wrappers call the commands (Frontend track)

**Files:** Modify `ui/src/lib/update/updater.ts`.

- [ ] **Step 1: Replace the file contents**

Replace `ui/src/lib/update/updater.ts` with:

```ts
import { invoke, Channel } from "@tauri-apps/api/core";

export type UpdateInfo = { version: string; notes?: string };
export type UpdateChannel = "stable" | "nightly";

type UpdateMeta = { version: string; currentVersion: string; notes?: string | null };
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/**
 * Check the given channel for an update via the Rust command. `allowDowngrade`
 * is true only for an explicit channel switch. Returns null on no-update / error
 * (never throws — preserves silent-no-op-offline behavior).
 */
export async function checkForUpdate(
  channel: UpdateChannel,
  allowDowngrade: boolean,
): Promise<UpdateInfo | null> {
  try {
    const meta = await invoke<UpdateMeta | null>("check_update", { channel, allowDowngrade });
    if (!meta) return null;
    return { version: meta.version, notes: meta.notes ?? undefined };
  } catch (e) {
    console.warn("Update check failed:", e);
    return null;
  }
}

/** Download + install the pending update (Rust relaunches on success). */
export async function applyUpdate(onProgress?: (pct: number) => void): Promise<void> {
  let total = 0;
  let got = 0;
  const onEvent = new Channel<DownloadEvent>();
  onEvent.onmessage = (msg) => {
    if (msg.event === "Started") {
      total = msg.data.contentLength ?? 0;
    } else if (msg.event === "Progress") {
      got += msg.data.chunkLength;
      if (total) onProgress?.(Math.min(100, Math.round((got / total) * 100)));
    } else if (msg.event === "Finished") {
      onProgress?.(100);
    }
  };
  await invoke("install_update", { onEvent });
}
```

- [ ] **Step 2: Type-check** (`npm --prefix ui run check`) — expect 0 errors (consumers updated in Task 5; the exported signatures changed, so `updateStore` will show errors until Task 5 — run check after Task 5 instead if doing them back-to-back).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/update/updater.ts
git commit -m "feat(update): updater wrappers call channel-aware Rust commands"
```

---

## Task 5: Channel-aware update store (Frontend track)

**Files:** Modify `ui/src/lib/update/updateStore.svelte.ts`; Test `ui/src/lib/update/updateStore.test.ts` (new).

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/update/updateStore.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run — expect FAIL** (`npm --prefix ui run test -- updateStore`) — `switchChannel` missing / wrong args.

- [ ] **Step 3: Update `updateStore.svelte.ts`**

Replace the imports and the `checkOnLaunch` method, and add `switchChannel`. The new top imports:

```ts
import { checkForUpdate, applyUpdate, type UpdateInfo } from "./updater.js";
import { settings, type UpdateChannel } from "$lib/stores/settings.svelte.js";
```

Remove the now-unused `import type { Update } ...` and the `_pending` field (the pending update now lives in Rust). Replace `checkOnLaunch` and add `switchChannel`:

```ts
  /** Called once on launch. Checks the persisted channel, upgrade-only. Silent no-op on none/offline/error. */
  async checkOnLaunch(): Promise<void> {
    const info = await checkForUpdate(settings.updateChannel, false);
    if (info) this.available = info;
  }

  /** Switch channels (persist) and check the new channel allowing a downgrade,
   *  so picking a lower channel immediately offers that channel's latest. */
  async switchChannel(next: UpdateChannel): Promise<void> {
    settings.setChannel(next);
    const info = await checkForUpdate(next, true);
    this.available = info; // null clears any stale banner; non-null offers the switch target
  }
```

And change `install()` to drop the `_pending` guard (install now targets the Rust-held pending update):

```ts
  /** Download + install the pending update, then relaunch. */
  async install(): Promise<void> {
    this.installing = true;
    this.error = null;
    try {
      await applyUpdate((p) => (this.progress = p));
    } catch (e) {
      this.error = String(e);
      this.installing = false;
    }
  }
```

- [ ] **Step 4: Run — expect PASS** (`npm --prefix ui run test -- updateStore`).

- [ ] **Step 5: Full type-check + tests** (`npm --prefix ui run check && npm --prefix ui run test`) — expect 0 errors, all green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/update/updateStore.svelte.ts ui/src/lib/update/updateStore.test.ts
git commit -m "feat(update): channel-aware checkOnLaunch + switchChannel"
```

---

## Task 6: Config — default endpoint + capabilities (Rust track)

**Files:** Modify `tauri.conf.json`, verify `capabilities/default.json`.

- [ ] **Step 1: Point the static default endpoint at stable**

In `tauri.conf.json`, the `plugins.updater.endpoints` currently lists the nightly URL. Change it to the stable channel (the Rust builder overrides per call; this is just the default/fallback):

```json
      "endpoints": [
        "https://gitea.howlab.co/dave/xbox-remote/releases/download/stable/latest.json"
      ],
```

Leave `pubkey` unchanged.

- [ ] **Step 2: Confirm capabilities**

`capabilities/default.json` currently has `"updater:default"` and `"process:allow-restart"`. The new custom commands (`check_update`/`install_update`) are allowed by default (custom commands need no capability entry). `app.restart()` is Rust-side and needs no JS capability, but leave `process:allow-restart` and `updater:default` in place — other paths/plugins may rely on them and trimming is out of scope. No change required; just verify the file still reads as above.

- [ ] **Step 3: Commit (if changed)**

```bash
git add tauri.conf.json
git commit -m "chore(updater): default static endpoint to stable channel"
```

---

## Task 7: Docs (Lead)

**Files:** Modify `docs/RELEASES.md`.

- [ ] **Step 1: Note the selector exists**

In `docs/RELEASES.md`, in the Channels section, replace the parenthetical that says the in-app selector is "a separate change" with:

```markdown
The app's **Settings → Update channel** toggle chooses which manifest the updater
polls. Default is **Stable**; switching to **Nightly** opts into pre-release builds.
Launch checks only ever upgrade; switching channels in Settings will move you to the
chosen channel's latest build immediately (even if that's a lower version).
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASES.md
git commit -m "docs: document the in-app update channel selector"
```

---

## Task 8: Integration build + smoke test (Lead)

**Files:** none (verification).

- [ ] **Step 1: Frontend build** — `npm --prefix ui run build` → succeeds.
- [ ] **Step 2: Full type-check + unit tests** — `npm --prefix ui run check && npm --prefix ui run test` → 0 errors, all pass (incl. new `settings` + `updateStore` tests).
- [ ] **Step 3: Rust build + tests** — `cargo clean -p xbox-remote && cargo build && cargo test` → builds, `updater::tests` pass.
- [ ] **Step 4: Manual smoke test** — `cargo run`. Open Settings → confirm the **Update channel** toggle (Stable default). Flip to Nightly and back; confirm no crash and (via logs / the update banner) that a check runs against the matching `latest.json`. From this `0.4.0` build, switching to **Stable** should surface a banner offering `v0.3.0` (downgrade-on-switch).
- [ ] **Step 5: Final commit (if smoke-test tweaks needed)** — otherwise skip.

---

## Task 9: SettingsModal channel toggle (Frontend track — do AFTER Task 5)

**Files:** Modify `ui/src/components/SettingsModal.svelte`.

(Listed last because it depends on Tasks 1 + 5; the Frontend track does it after Task 5.)

- [ ] **Step 1: Add imports**

In the `<script>` of `SettingsModal.svelte`, add:

```ts
  import Toggle from "$lib/design/Toggle.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { updateStore } from "$lib/update/updateStore.svelte.js";
```

- [ ] **Step 2: Add the channel handler**

In the `<script>`, add:

```ts
  // ── Update channel ───────────────────────────────────────────────────────────
  function handleChannelToggle(nightly: boolean) {
    void updateStore.switchChannel(nightly ? "nightly" : "stable");
  }
```

- [ ] **Step 3: Add an "Updates" section to the template**

Insert this section between the APPEARANCE section (`</section>` after ThemeSwitcher) and the ACCOUNT section:

```svelte
      <!-- ── Updates ─────────────────────────────────────────────────────── -->
      <section class="settings-section">
        <span class="settings-section__label">UPDATES</span>
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">Nightly builds</span>
            <span class="settings-row__desc">
              Get pre-release updates ahead of stable. Off = stable releases only.
            </span>
          </div>
          <Toggle
            checked={settings.updateChannel === "nightly"}
            label=""
            onchange={handleChannelToggle}
          />
        </div>
      </section>
```

- [ ] **Step 4: Type-check** (`npm --prefix ui run check`) — expect 0 errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/SettingsModal.svelte
git commit -m "feat(settings): update-channel toggle in Settings"
```

---

## Self-Review Notes

- **Spec coverage:** persisted channel store (Task 1); Rust endpoint + commands (Tasks 2-3); JS rewire (Task 4); channel-aware launch/switch (Task 5); config default (Task 6); docs (Task 7); UI toggle (Task 9); verification (Task 8). `allow_downgrade` split: `false` in `checkOnLaunch`, `true` in `switchChannel` (Task 5) — matches spec.
- **Contract consistency:** command names `check_update`/`install_update`, args `{ channel, allowDowngrade }` / `{ onEvent }`, `UpdateMeta` camelCase fields, and `DownloadEvent` tag/content shape are identical across Tasks 3 (Rust) and 4 (JS).
- **No placeholders:** every code step is complete. The one flagged unknown (exact `tauri-plugin-updater` closure signatures) has explicit "adjust to compiler, preserve behavior + serde shapes" guidance in Task 3.
- **Ordering for the team:** Rust 2→3→6 and Frontend 1→4→5→9 run in parallel; Task 8 (lead) is the integration barrier at the end. SettingsModal (9) is sequenced after 5 within the frontend track.
