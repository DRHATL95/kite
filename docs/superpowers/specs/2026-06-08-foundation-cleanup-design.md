# Foundation Cleanup — Design Spec

- **Date:** 2026-06-08
- **Status:** Draft (awaiting user review)
- **Spec:** 1 of 4 in the "Greatly Improve Xbox Remote" program
- **Author:** David Howard + Claude

---

## 1. Program context

This is the **first of four sequenced specs** to evolve Xbox Remote into a reliable,
modern, audio-first daily-driver. Sequencing (Approach A — "instrument, stabilize, beautify"):

| # | Spec | Status |
|---|------|--------|
| **1** | **Foundation cleanup** (this doc) | Draft |
| 2 | Re-platform frontend (Svelte 5 + Vite) + diagnostics HUD + design-system foundation | Not started |
| 3 | Stream stability & quality (audio-first): TURN, ICE/keepalive hardening, keyframe recovery, adaptive bitrate, video-off/low-res mode | Not started |
| 4 | Full visual UI overhaul (Discord "stage" view, polish) | Not started |

**North star:** a cloud Remote Play app the owner actually uses daily, primarily for
**audio** (occasionally video shared to Discord). Controller is a minor concern.
Target: **cross-platform** (Windows / macOS / Linux). Priority is **performance and
being up-to-date**, not feature count.

### Why Foundation first

The repo currently misleads anyone who reads it: ~40% of the dependency tree is dead,
an entire phantom architecture (`src/streaming/` Nano/GStreamer/MJPEG) is documented
but does not exist, and 14 contradictory status docs claim things the code contradicts.
Foundation clears this fog so Specs 2–4 happen on a clean, truthful base. It is
deliberately **low-risk** (mostly deletion, config, and docs) and excludes frontend
cleanup because Spec 2 rewrites the frontend anyway.

---

## 2. Locked decisions (from brainstorming)

1. **Local discovery + CLI → drop it all, go cloud-only.** Remove SSDP, the SmartGlass
   chain, the local-discovery Tauri commands, and the no-UI CLI binary. Tauri becomes
   the single build path.
2. **Token security → full OS keychain now**, via the cross-platform `keyring` crate,
   with one-time migration from the existing plaintext token file.
3. **Docs → consolidate but archive only.** Rewrite/rename/merge into a clean set; move
   superseded docs into `docs/history/` rather than deleting them.
4. (Carried) Frontend framework for Spec 2 = **Svelte 5 + Vite**. Recorded here for
   continuity; not implemented in Foundation.

---

## 3. Scope

### In scope
- Remove verified-dead dependencies (19 crates + the `gstreamer-support` feature).
- Remove verified-dead code (commands, functions, the SmartGlass chain, vestigial fields).
- Collapse local discovery + CLI into a **single cloud-only Tauri build path**
  (delete `src/discovery/`, remove the feature split).
- Replace plaintext token storage with **OS keychain + migration** (`keyring`).
- Externalize the hardcoded Azure **client ID** to `XBOX_CLIENT_ID` (env, with fallback).
- **Modernize versions**: refresh remaining deps to current; move to Rust **edition 2024**.
- **Docs**: rewrite `CLAUDE.md` to reality, consolidate/rename the rest, archive
  superseded docs to `docs/history/`, delete the stray `nul`, add `.gitignore` entries.
- Seed a minimal **test** for the new token-store + client-id resolution logic.

### Out of scope (later specs)
- Any frontend changes (Spec 2).
- TURN/ICE/keepalive/bitrate stability work (Spec 3) and the diagnostics HUD (Spec 2/3).
- Re-architecting WebRTC into Rust — explicitly deferred to "decide after we instrument."
- Visual redesign (Spec 4).

---

## 4. Work breakdown

> Every removal below is backed by the verified Foundation removal audit
> (workflow `wf_7d491ab7-bf8`). File:line references are from that audit.

### A. Remove dead dependencies

Remove from `Cargo.toml` (all confirmed zero usage in `src/`):

`webrtc`, `webrtc-sdp`, `gstreamer`, `gstreamer-video`, `gstreamer-audio`,
`gstreamer-app`, `gstreamer-rtp`, `axum`, `tower-http`, `oauth2`, `mdns-sd`,
`trust-dns-resolver`, `bytes`, `tokio-util`, `base64`, `urlencoding`, `futures`,
`url`, `uuid`, `anyhow` — **plus delete the `gstreamer-support` feature** (`Cargo.toml:73`).

- `rand` (`Cargo.toml`) — **conditionally removable**: its only use is the SmartGlass
  client-UUID at `discovery/mod.rs:92`. It becomes dead once the SmartGlass chain
  (§C) is removed. Remove it **in the same pass as §C, then re-grep to confirm**.
- **Keep:** `tauri`, `tauri-plugin-shell`, `tauri-build`, `serde`, `serde_json`,
  `tokio`, `reqwest`, `chrono`, `dirs`, `thiserror`, `tracing`, `tracing-subscriber`.
- **Add:** `keyring` (§D).

**Verification:** after removals, run `cargo build` and (ideally) `cargo machete` or
`cargo +nightly udeps` to confirm no remaining dep is unused and nothing referenced a
removed crate.

### B. Remove dead code

| Target | Location | Note |
|---|---|---|
| `send_sdp_answer` Tauri command | `main.rs:100, 277-291` | Frontend uses `exchange_sdp`; remove command **and** its impl `XHomeClient::send_sdp_answer()` (`xhome.rs:1066`) together. |
| `get_stream_status` Tauri command | `main.rs:104, 362-374` | No callers; frontend only uses `set_stream_status`. |
| `XHomeClient::get_sdp_offer()` | `xhome.rs:687` | Private, zero callers; `create_session` uses `exchange_sdp_offer`→`poll_for_sdp_answer`. |
| `StreamConfig.streaming_mode` + `default_streaming_mode()` | `xhome.rs:59, 69-71` | Always overwritten to `"webrtc"` at `xhome.rs:484`; never read back. |
| `StreamConfig.serverIp` / `serverPort` | `xhome.rs:53-57, 494-495` | Always `None`, `skip_serializing_if`, never consumed. |

- **`nanoVersion`** (`xhome.rs:130-131, 402`): **keep** (the server may require it) but
  convert to a named `const` with a comment noting it configures WebRTC transport
  despite its legacy name. Do **not** make it user-configurable.

### C. Collapse to a single cloud-only build path (structural)

This is the highest-ripple change — implement carefully and build-verify after each step.

1. **Delete the no-UI CLI** main (`src/main.rs:12-59`, `#[cfg(not(feature="tauri"))]`).
2. **Make Tauri non-optional**: remove the `tauri` feature gate and `default = []` /
   `tauri = [...]` lines; promote `tauri`, `tauri-plugin-shell` to normal deps and
   `tauri-build` stays a build-dependency. `build.rs` always calls `tauri_build::build()`.
   Result: `cargo run` launches the app; the dual-config build matrix disappears.
3. **Delete `src/discovery/`** entirely (SSDP `discover()`, `parse_ssdp_response`, the
   SmartGlass chain `discover_smartglass`/`parse_smartglass_response`/`extract_console_name`/
   `extract_live_id`, the `SMARTGLASS_DISCOVERY_REQUEST` const, `XboxConsole`,
   `XboxDiscovery`). The cloud path uses `XHomeConsole` in `xhome.rs` and never touches
   this module. The lone unit test (`to_json_safe`, `discovery/mod.rs:354-374`) tests
   dead code and is removed with it (a real test is added in §D).
4. **Remove the local-discovery Tauri commands** `discover_consoles` (`main.rs:102`) and
   `discover_local_xbox` (`main.rs:103`), and drop `Mutex<XboxDiscovery>` from `AppState`
   and its construction in `main.rs`.
5. **Remove `rand`** (now orphaned) per §A; re-grep to confirm.
6. Update `mod` declarations in `main.rs` to drop `discovery`.

**Verification gate:** `cargo build` succeeds with the now-single build path; the app
launches; the console list still populates via `discover_xhome_consoles`.

### D. Token storage → OS keychain + migration

Replace plaintext JSON token persistence (`auth.rs:16, 97, 162-168`) with the
cross-platform `keyring` crate (Windows Credential Manager / macOS Keychain /
Linux Secret Service).

- **Storage abstraction:** introduce a small `TokenStore` boundary so `auth.rs` no
  longer reads/writes the file directly. It exposes `load() -> Option<XboxTokens>`,
  `save(&XboxTokens)`, `clear()`. Keychain entry: service `"xbox-remote"`, key e.g.
  `"tokens"`; the `XboxTokens` struct is serialized to JSON and stored as the secret.
- **One-time migration:** on `load()`, if the keychain has no entry **and** a legacy
  `~/<config>/xbox-remote/xbox_tokens.json` exists → parse it, `save()` to keychain,
  then **delete the plaintext file**. Log the migration at `info`. This is the one piece
  with a real correctness decision (what to do on partial/corrupt legacy files) — see the
  migration risk in §7.
- `dirs` is **kept** (used to locate the legacy file for migration; also handy for any
  future config). Re-evaluate removing it in a later pass.

**Verification:** unit-test the migration logic (legacy present → migrated + file gone;
keychain present → legacy ignored; neither → `None`). Manually confirm a real auth
round-trips and survives an app restart with no plaintext file on disk.

### E. Externalize the Azure client ID

`auth.rs:13` `const CLIENT_ID` is used at `auth.rs:180, 231, 288`.

- Resolve at runtime: `std::env::var("XBOX_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID)`
  where `DEFAULT_CLIENT_ID` keeps the current literal for back-compat.
- Document `XBOX_CLIENT_ID` in `AZURE_APP_SETUP.md` (renamed `AZURE_SETUP.md`) and `README.md`.
- Cross-platform safe (no platform-specific env handling).

### F. Version modernization

Do **after** §A–§E so the version delta is isolated and bisectable.

- Move to **Rust edition 2024** in `Cargo.toml` (requires Rust ≥ 1.85; verify local
  toolchain). Fix the resulting edition-2024 lints.
- Refresh remaining deps to current stable (`tauri` 2.x latest, `reqwest`, `tokio`,
  `serde`, `chrono`, `tracing*`, `thiserror`, `dirs`, `keyring`). Bump conservatively;
  `cargo build` + manual smoke test after.
- Update CLAUDE.md's edition statement to match.

### G. Documentation consolidation (archive-only) + housekeeping

Use `git mv` for renames/archives so history follows the file.

**Create** `docs/history/` (+ `docs/history/milestones/`, `docs/history/design-docs/`).

**Archive (move, don't delete):**
- `PHASE_2_COMPLETE.md` → `docs/history/milestones/`
- `BUTTON_DEBUG.md` → `docs/history/` (after merging any WSL/X11 debug value into TROUBLESHOOTING)
- `AUTH_TESTING.md`, `TEST_NOW.md` → `docs/history/` (after merging unique console-log
  sequences + manual-test commands into `TESTING_GUIDE.md`)
- `docs/plans/2026-03-15-finish-implementation-design.md` → `docs/history/design-docs/`
- `docs/plans/2026-03-15-connection-manager-design.md` → `docs/history/design-docs/`
  (ConnectionManager exists in `app.js`, so this is implemented history)

**Rename + update:**
- `IMPLEMENTATION_SUMMARY.md` → `TECHNICAL_DETAILS.md` (authoritative technical reference)
- `TESTING.md` → `TESTING_GUIDE.md` (absorbs AUTH_TESTING + TEST_NOW unique content)
- `DEBUG_WINDOW.md` → `TROUBLESHOOTING.md` (absorbs BUTTON_DEBUG)
- `IMPLEMENTATION_STATUS.md` → `docs/PHASES.md` (mark Phase 2 complete)
- `STREAMING_ARCHITECTURE.md` → `docs/ARCHITECTURE_RESEARCH.md`
- `AZURE_APP_SETUP.md` → `AZURE_SETUP.md`

**Keep + update:** `README.md` (reflect cloud-WebRTC reality + cross-platform + Windows
dev note), `START_HERE.md` (update links + drop CLI instructions).

**Rewrite `CLAUDE.md`** to the real architecture:
- Fix the edition statement (it currently claims 2024 in prose — after §F it really is 2024,
  so make the whole doc consistent).
- **Delete** the entire "Video Streaming Architecture" section describing
  `src/streaming/nano.rs`, `src/streaming/video_receiver.rs`, the GStreamer→MJPEG
  pipeline, and port 8080 — **none of it exists**.
- Replace with the true flow: OAuth device-code (`auth.rs`) → Xbox Live → XSTS →
  xHome cloud API (`xhome.rs`) → **browser** WebRTC; signaling via REST, media via WebRTC.
- Remove the `src/discovery/` description (module deleted) and the local SSDP/SmartGlass
  protocol sections; document cloud discovery only.
- Update the Tauri command list to the surviving commands.
- Update build commands: single `cargo run` (no feature flags, no CLI mode).
- Note cross-platform target + Windows-based development.

**Housekeeping:**
- Delete the stray `nul` file (Windows reserved name — use `git rm nul`; if that fails,
  `del \\?\C:\Projects\xbox-remote\nul`). Add `nul` to `.gitignore`.
- Given cloud-only: `check_xbox.sh` (CLI discovery test) and `test_gstreamer.sh` are now
  stale → archive to `docs/history/` or delete. Keep `run.sh`/`quick_test.sh` (update to
  the single build path). Optionally add `SCRIPTS.md`.
- Ensure `.gitignore` covers `/target`, token artifacts, `nul`.

---

## 5. Cargo.toml shape (before → after)

- **Dependencies:** ~26 → ~12 (remove 19 dead + `rand` conditionally; add `keyring`).
- **Features:** remove `gstreamer-support` and the `tauri`/`default` feature split entirely.
- **Edition:** 2021 → 2024.
- **`build.rs`:** always runs `tauri_build::build()` (no longer feature-gated).

---

## 6. Acceptance criteria

Foundation is "done" when **all** hold:

1. `cargo build` succeeds with the single cloud-only path; **no** `--features` needed.
2. `cargo clippy` is clean of new warnings introduced by the edition/version bump.
3. `cargo machete`/`udeps` reports **no** unused dependencies.
4. App launches, authenticates (device-code), and lists cloud consoles via
   `discover_xhome_consoles`.
5. Tokens are stored in the **OS keychain**; a pre-existing plaintext `xbox_tokens.json`
   is migrated and then **absent from disk**; auth survives an app restart.
6. `XBOX_CLIENT_ID` env override works; unset falls back to the default.
7. New unit tests pass: token-store migration + client-id resolution.
8. `CLAUDE.md` contains **no** reference to `src/streaming/`, Nano, GStreamer, MJPEG,
   port 8080, or local SSDP/SmartGlass discovery; describes the real cloud-WebRTC flow.
9. `nul` removed; doc set consolidated; superseded docs present under `docs/history/`.
10. A session can still be created against a real Xbox (no regression in `xhome.rs`
    signaling) — smoke-tested manually; stream *quality* is explicitly out of scope here.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Deleting `src/discovery/` breaks a hidden reference (AppState, commands, `mod`) | Compiler is the gate: remove, `cargo build`, fix references until green. Search for `XboxDiscovery`/`XboxConsole`/`discovery::` first. |
| Removing the feature split breaks `build.rs`/Tauri init | Make `tauri_build::build()` unconditional; verify `cargo run` launches a window. |
| `rand` removed while still used | Remove only **after** the SmartGlass chain; re-grep `rand::` before deleting from Cargo.toml. |
| `uuid`/`anyhow` were not in the first recon | Independently grep-confirmed dead; `cargo build` is the final proof — restore if a macro/transitive re-export needs them. |
| Keychain unavailable in some environments (headless Linux CI, locked keyrings) | `TokenStore` returns a typed error; app degrades to "must re-auth" rather than crashing. Document the Linux Secret Service requirement. |
| Keychain migration on a corrupt/partial legacy file | Treat parse failure as "no legacy tokens" (log a warning, leave the file in place for manual inspection rather than deleting). |
| Edition 2024 needs a newer toolchain than installed | Check `rustc --version` first; if < 1.85, either update toolchain or defer §F (keep 2021) and note it. |
| Doc archive loses unique content | Merge AUTH_TESTING/TEST_NOW/BUTTON_DEBUG unique content into the consolidated docs **before** moving the originals. |
| `nul` resists deletion on Windows | Use `git rm`; fall back to the `\\?\` path form. |

---

## 8. Decision records (ADR-style)

- **ADR-1 — Cloud-only, single build path.** The product value is cloud Remote Play; the
  local SSDP/SmartGlass/CLI paths are unused by the GUI and (SmartGlass) fabricated.
  Deleting them removes a whole module, a dependency, and the dual-feature build matrix
  for a large net simplification, at the cost of giving up a (non-functional) local path.
  Reversible via git history if a real local-streaming feature is ever pursued.
- **ADR-2 — OS keychain for tokens (`keyring`).** Plaintext refresh/XSTS tokens on disk
  are the app's main credential-theft risk. `keyring` is the cross-platform, "up-to-date"
  answer and fits the cross-platform goal; the cost is one dependency + a one-time
  migration. Chosen over file-perm hardening (weaker) and "defer" (leaves the risk open).
- **ADR-3 — Svelte 5 + Vite for the Spec 2 frontend.** Smallest runtime, compile-time
  reactivity (no VDOM diffing) suits a high-frequency diagnostics HUD, first-class Tauri
  integration. Recorded now; implemented in Spec 2.

---

## 9. Notes for implementation (carry-forward)

- Tauri frontend rebuilds: remember `cargo clean -p xbox-remote` before rebuild to pick
  up frontend asset changes (known gotcha; mainly relevant in Spec 2).
- `.cargo/config.toml` `jobs = 4` is a deliberate Windows compiler-stability workaround —
  keep it, and add a comment saying so.
- Keep all `xhome.rs` signaling logic intact — it is the working core and out of scope
  for changes here beyond the dead-code removals in §B.
