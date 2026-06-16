# Update Channel Selector — SP2: In-App Stable/Nightly Selection

**Date:** 2026-06-13
**Status:** Draft (pending spec review)
**Branch:** `feat/update-channel-selector`
**Sub-project:** 2 of 2. SP1 (versioning + dual-channel publishing) is shipped on
`master`; this adds the in-app selector that chooses between the two channels.

## Problem

SP1 publishes two rolling updater manifests — `…/releases/download/nightly/latest.json`
and `…/releases/download/stable/latest.json` — but the app's updater is hardwired to
the **nightly** endpoint baked into `tauri.conf.json`. So every install auto-updates
along `nightly` regardless of whether the user wants stable releases. There is no way
to choose a channel.

The JS updater API (`@tauri-apps/plugin-updater` `check()`) accepts only
`headers/timeout/proxy/target/allowDowngrades` — **no runtime endpoint override**. So
channel selection cannot be done from JS against the static config; it requires the
Rust updater builder.

## Goals

1. A **Settings toggle** lets the user choose **Stable** or **Nightly**, persisted
   across launches, defaulting to **Stable**.
2. The launch update check polls the **selected channel's** `latest.json`.
3. Switching channels in Settings **immediately offers that channel's latest build,
   even if it is a lower version** (so "switch to Stable" actually moves you to
   Stable now), while the **launch check stays upgrade-only** (opening the app never
   nags a downgrade).
4. Preserve current resilience: checks never throw; offline/no-update is a silent
   no-op.

## Non-goals

- Per-platform or beta/canary channels beyond `stable`/`nightly`.
- Changing the publishing side (that's SP1, already shipped).
- A full settings-persistence framework — just the one channel value.

## Decisions (locked)

- **Default channel:** `stable`. New installs and existing users default to Stable;
  nightly testers opt in. Existing nightly users do a one-time flip to keep nightlies.
- **Switch behavior:** allow downgrade on an **explicit** channel switch; launch
  checks are upgrade-only.

## Architecture

### Why Rust commands (the load-bearing constraint)

Runtime endpoint selection requires `app.updater_builder().endpoints([url])` (Rust).
The resulting `Update` handle lives Rust-side, so **both check and install move to
Rust commands** (the pattern from the Tauri updater docs). The JS layer becomes a thin
caller. This replaces the current direct `@tauri-apps/plugin-updater` `check()` /
`Update.downloadAndInstall()` calls in `ui/src/lib/update/updater.ts`.

### Components

**1. Channel setting — `ui/src/lib/stores/settings.svelte.ts` (new)**
A small Svelte 5 rune store:
- `updateChannel: "stable" | "nightly"` ($state), initialised from `localStorage`
  key `xbox-remote:update-channel`, defaulting to `"stable"`.
- `setChannel(c)` updates the rune and writes `localStorage`.
- Mirrors the persistence approach already used by `theme.svelte.ts`.

**2. Rust updater module — `src/updater.rs` (new), registered in `src/main.rs`**
- Pure helper (unit-testable):
  ```rust
  /// Map a channel name to its rolling latest.json endpoint.
  pub fn channel_endpoint(channel: &str) -> String {
      let ch = if channel == "nightly" { "nightly" } else { "stable" }; // unknown -> stable
      format!("https://gitea.howlab.co/dave/xbox-remote/releases/download/{ch}/latest.json")
  }
  ```
  (Unknown/invalid channel falls back to `stable` — safe default.)
- Managed state: `struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);`
- Command `check_update(channel: String, allow_downgrade: bool) -> Result<Option<UpdateMeta>, String>`:
  builds the updater with `.endpoints([channel_endpoint(&channel)])`; when
  `allow_downgrade`, attaches `.version_comparator(|cur, upd| upd.version != cur)`;
  runs `.check().await`; stores the pending `Update` in state; returns
  `UpdateMeta { version, current_version, notes }` or `None`. Errors map to `String`
  (the JS wrapper swallows them → silent no-op, preserving current behavior).
- Command `install_update(on_event: Channel<DownloadEvent>) -> Result<(), String>`:
  takes the pending `Update`, `download_and_install` emitting
  `Started { content_length } / Progress { chunk_length } / Finished` on the Tauri
  `Channel`, then relaunches (`app.restart()` / process plugin).

**3. Frontend updater wrappers — `ui/src/lib/update/updater.ts` (modified)**
- `checkForUpdate(channel, allowDowngrade): Promise<UpdateInfo | null>` →
  `invoke("check_update", { channel, allowDowngrade })`; returns null on error
  (try/catch, as today).
- `applyUpdate(onProgress): Promise<void>` → creates a Tauri `Channel<DownloadEvent>`,
  maps `Started/Progress/Finished` to the existing 0–100 progress semantics (clamp to
  100; pin 100 on Finished), and `invoke("install_update", { onEvent })`.

**4. Update store — `ui/src/lib/update/updateStore.svelte.ts` (modified)**
- `checkOnLaunch()`: read `settings.updateChannel`, call
  `checkForUpdate(channel, /*allowDowngrade*/ false)`.
- `switchChannel(next)`: `settings.setChannel(next)`, then
  `checkForUpdate(next, /*allowDowngrade*/ true)`; if it returns metadata, set
  `available` so the banner offers it (this is how "switch to Stable now" surfaces).
- `install()`: unchanged shape — calls `applyUpdate` with progress.

**5. Settings UI — `ui/src/components/SettingsModal.svelte` (modified)**
An "Update channel" row with a **Stable / Nightly** segmented control (reuse
`ui/src/lib/design/Toggle.svelte`). `onchange` → `settings.setChannel(x)` then
`updateStore.switchChannel(x)`. The existing `UpdateBanner` surfaces any resulting
update; no banner redesign required.

**6. Config — `tauri.conf.json` / `capabilities/default.json`**
- Keep the updater `pubkey` (signatures still verified by the Rust builder).
- Repoint the static `endpoints` default to the **stable** `latest.json` (matches the
  new default; the Rust builder overrides per call anyway).
- Confirm `capabilities/default.json` permits the two new commands (custom commands
  are allowed by default). The JS `updater`/`process` plugin permissions may be
  trimmable since check+install move to Rust — verify in the plan; trim only if
  nothing else needs them.

## Data flow

```
launch: App.svelte onMount
  └─ updateStore.checkOnLaunch()
       └─ checkForUpdate(settings.updateChannel, allowDowngrade=false)
            └─ invoke check_update -> Rust: updater_builder().endpoints([channel latest.json]).check()
                 -> UpdateMeta? -> banner if higher version

settings: user picks "Stable"
  └─ settings.setChannel("stable")  (persist localStorage)
  └─ updateStore.switchChannel("stable")
       └─ checkForUpdate("stable", allowDowngrade=true)
            └─ invoke check_update (version_comparator: any-difference)
                 -> UpdateMeta (even if lower) -> banner "vX.Y.Z available — Install"

install: banner -> updateStore.install()
  └─ applyUpdate(onProgress) -> invoke install_update(onEvent=Channel)
       └─ Rust: pending Update.download_and_install(progress->Channel) -> relaunch
```

## Error handling & edge cases

- **Offline / no update / endpoint 404:** `check_update` returns `Err`/`None`; the JS
  wrapper catches → silent no-op (unchanged behavior).
- **No pending update on install:** `install_update` returns an error variant; JS
  surfaces it via the existing `updateStore.error`.
- **Unknown channel value in localStorage:** `channel_endpoint` falls back to
  `stable`; the store also normalises unknown values to `stable` on read.
- **Switch to the channel you're already on:** still runs a check (harmless;
  upgrade-or-equal → usually no banner).
- **Downgrade-on-switch then dismiss:** banner dismiss just hides it; the channel
  setting stays changed, so the next launch checks the new channel (upgrade-only).
- **Signature mismatch:** the Rust builder verifies against `pubkey`; a bad signature
  fails the check → no-op (never installs unsigned).

## Testing

- **Rust unit test** (`src/updater.rs`): `channel_endpoint("stable")` /
  `("nightly")` / `("garbage")` produce the expected URLs (garbage → stable).
- **Frontend unit tests** (vitest):
  - `settings.svelte.ts`: persists to and restores from `localStorage`; defaults to
    `stable`; normalises unknown values.
  - `updateStore.switchChannel`: calls the check with `allowDowngrade=true` and the
    new channel; `checkOnLaunch` calls with `allowDowngrade=false` and the persisted
    channel (mock `invoke`/the updater wrapper).
- **Manual:** flip channel in Settings; confirm (via logs/devtools) the correct
  `latest.json` is fetched; from a nightly build, switch to Stable and confirm the
  banner offers `v0.3.0`; confirm launch on stable does not offer a downgrade.
- **No regression:** existing connection/media/stats tests untouched; full
  `npm --prefix ui run test` + `cargo test` stay green.

## Files touched

| File | Change |
|---|---|
| `ui/src/lib/stores/settings.svelte.ts` | **new** — persisted `updateChannel` store |
| `src/updater.rs` | **new** — `channel_endpoint`, `check_update`, `install_update`, `PendingUpdate` |
| `src/main.rs` | register module, commands, manage `PendingUpdate` state |
| `ui/src/lib/update/updater.ts` | call Rust commands instead of JS plugin directly |
| `ui/src/lib/update/updateStore.svelte.ts` | channel-aware `checkOnLaunch` + `switchChannel` |
| `ui/src/components/SettingsModal.svelte` | Stable/Nightly toggle row |
| `tauri.conf.json` | default `endpoints` → stable; keep pubkey |
| `capabilities/default.json` | confirm/trim updater-related perms |
| `docs/RELEASES.md` | note the in-app channel selector now exists |

> Build reminder (CLAUDE.md): after `ui/src/` changes, `npm --prefix ui run build`
> then `cargo clean -p xbox-remote && cargo run`; Tauri embeds `ui/dist` at compile time.
