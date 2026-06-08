# Foundation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip dead code/deps, collapse Xbox Remote to a single cloud-only Tauri build path, move tokens to the OS keychain, externalize the client ID, modernize versions, and consolidate docs — producing a clean, truthful base for Specs 2–4.

**Architecture:** The app is a cloud Remote Play client: OAuth device-code → Xbox Live → XSTS → xHome REST signaling → browser WebRTC media. Foundation removes everything that doesn't serve that path (local SSDP/SmartGlass discovery, the no-UI CLI, ~19 unused crates) and hardens token storage. The working `auth.rs`/`xhome.rs` signaling logic is preserved; only dead code is removed around it.

**Tech Stack:** Rust (edition 2021 → 2024), Tauri 2, `reqwest`, `tokio`, `serde`, `keyring` (new), `tempfile` (new dev-dep). Spec is `docs/superpowers/specs/2026-06-08-foundation-cleanup-design.md`.

**Branch:** `foundation-cleanup` (already created; the spec is committed there).

---

## File map

| File | Change |
|---|---|
| `Cargo.toml` | Remove 19 dead deps + `gstreamer-support`/feature split; make Tauri non-optional; add `keyring` + `tempfile` (dev); edition 2024 |
| `build.rs` | `tauri_build::build()` unconditional |
| `src/main.rs` | Delete CLI main; un-gate Tauri main + `tauri_commands`; remove `discovery` mod + 4 dead commands + `AppState.discovery` |
| `src/discovery/` | **Delete the directory** (SSDP + SmartGlass + `XboxConsole`/`XboxDiscovery`) |
| `src/xhome.rs` | Remove `get_sdp_offer`, `send_sdp_answer`; drop vestigial `StreamConfig` fields + `default_streaming_mode`; `nanoVersion` → named const |
| `src/token_store.rs` | **New** — `TokenStore` + `SecretBackend`/`KeyringBackend` + tests |
| `src/auth.rs` | Use `TokenStore` for persistence; `resolve_client_id()` env override |
| docs (many) | Consolidate (archive-only) + rewrite `CLAUDE.md`; delete `nul`; update `.gitignore` |

---

## Task 1: Collapse to a single Tauri build path

**Files:**
- Modify: `Cargo.toml` (deps + features)
- Modify: `build.rs`
- Modify: `src/main.rs:1-119` (remove CLI main, un-gate Tauri)

- [ ] **Step 1: Make Tauri non-optional in `Cargo.toml`**

Replace the optional Tauri deps (lines 7–9) with non-optional, keeping devtools:

```toml
# Tauri framework
tauri = { version = "2.0", features = ["devtools"] }
tauri-plugin-shell = "2.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
```

- [ ] **Step 2: Delete the entire `[features]` section from `Cargo.toml`**

Remove lines 70–73:

```toml
[features]
default = []
tauri = ["dep:tauri", "dep:tauri-plugin-shell", "tauri/devtools"]
gstreamer-support = ["dep:gstreamer", "dep:gstreamer-video", "dep:gstreamer-audio", "dep:gstreamer-app", "dep:gstreamer-rtp"]
```

(The `gstreamer-*` deps it referenced are removed in Task 4.)

- [ ] **Step 3: Make `build.rs` unconditional**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 4: Replace the top of `src/main.rs` (lines 1–9) — un-gate, keep console in debug**

```rust
// Hide the console window on Windows in release builds (keep it in debug so
// tracing logs are visible during development).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod discovery;
mod error;
mod xhome;

use discovery::XboxDiscovery;
```

- [ ] **Step 5: Delete the CLI main (`src/main.rs:11-59`)**

Remove the entire `#[cfg(not(feature = "tauri"))] async fn main()` block (the comment `// CLI-only main function` through its closing `}` at line 59).

- [ ] **Step 6: Un-gate the Tauri main and `tauri_commands` module**

Remove the two `#[cfg(feature = "tauri")]` attributes — one above `fn main()` (was line 62) and one above `mod tauri_commands` (was line 113). Both items become unconditional.

- [ ] **Step 7: Build and run**

Run: `cargo build`
Expected: `Finished` with no errors (warnings about unused deps are fine — Task 4 removes them).

Run: `cargo run`
Expected: the app window launches (this is now the only run mode; no `--features` needed).

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml build.rs src/main.rs
git commit -m "refactor: make Tauri the single build path, remove CLI main"
```

---

## Task 2: Delete local discovery (module + commands + state + rand)

**Files:**
- Delete: `src/discovery/` (whole directory)
- Modify: `src/main.rs` (mod decl, `use`, AppState, 2 commands)
- Modify: `Cargo.toml` (remove `rand`)

- [ ] **Step 1: Remove the `discovery` module wiring in `src/main.rs`**

Delete `mod discovery;` and `use discovery::XboxDiscovery;` from the top of the file.

- [ ] **Step 2: Remove `discovery` from `AppState` and its construction**

In the `setup` closure, delete the line:
```rust
let discovery = XboxDiscovery::new().expect("Failed to initialize discovery");
```
In `app.manage(tauri_commands::AppState { ... })`, delete the field `discovery: Mutex::new(discovery),`.
In the `tauri_commands::AppState` struct, delete the field `pub discovery: Mutex<XboxDiscovery>,`.

- [ ] **Step 3: Unregister the two local-discovery commands**

In `tauri::generate_handler![ ... ]`, delete these two lines:
```rust
tauri_commands::discover_consoles,
tauri_commands::discover_local_xbox,
```

- [ ] **Step 4: Delete the two command implementations**

In `mod tauri_commands`, delete the whole `discover_consoles` fn (was `src/main.rs:311-325`) and the whole `discover_local_xbox` fn (was `src/main.rs:327-358`), including their doc comments.

- [ ] **Step 5: Delete the discovery module directory**

```bash
git rm -r src/discovery
```

- [ ] **Step 6: Remove `rand` from `Cargo.toml`**

Delete the line `rand = "0.8"` (its only use was the SmartGlass client UUID, now deleted).

- [ ] **Step 7: Confirm nothing references the removed symbols**

Run: `cargo build`
Expected: `Finished`, no errors.

Run (sanity — must return nothing): `git grep -nE "XboxDiscovery|XboxConsole|discovery::|rand::"` 
Expected: no matches.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: drop local SSDP/SmartGlass discovery and the rand dep (cloud-only)"
```

---

## Task 3: Remove remaining dead code (commands, fns, vestigial fields)

**Files:**
- Modify: `src/main.rs` (2 commands)
- Modify: `src/xhome.rs` (2 fns, StreamConfig fields, nanoVersion const)

- [ ] **Step 1: Unregister and delete the `send_sdp_answer` command**

In `generate_handler![...]` delete `tauri_commands::send_sdp_answer,`.
Delete the `send_sdp_answer` command fn (was `src/main.rs:276-291`).

- [ ] **Step 2: Unregister and delete the `get_stream_status` command**

In `generate_handler![...]` delete `tauri_commands::get_stream_status,`.
Delete the `get_stream_status` command fn (was `src/main.rs:360-374`).

- [ ] **Step 3: Delete the `XHomeClient::send_sdp_answer()` impl in `src/xhome.rs`**

Delete the whole `pub async fn send_sdp_answer(...)` method (around `xhome.rs:1066`). It was only reachable from the command removed in Step 1.

- [ ] **Step 4: Delete the dead `get_sdp_offer()` in `src/xhome.rs`**

Delete the whole private `async fn get_sdp_offer(...)` method (around `xhome.rs:687`). It has zero callers (`create_session` uses `exchange_sdp_offer` → `poll_for_sdp_answer`).

- [ ] **Step 5: Remove vestigial `StreamConfig` fields**

In the `StreamConfig` struct (`xhome.rs:46-67`), delete these field blocks:
```rust
    /// Server IP for Nano protocol streaming
    #[serde(rename = "serverIp", skip_serializing_if = "Option::is_none")]
    pub server_ip: Option<String>,
    /// Server port for Nano protocol streaming
    #[serde(rename = "serverPort", skip_serializing_if = "Option::is_none")]
    pub server_port: Option<u16>,
    /// Streaming mode: "webrtc" or "nano"
    #[serde(rename = "streamingMode", default = "default_streaming_mode")]
    pub streaming_mode: String,
```
Then delete the now-unused function (`xhome.rs:69-71`):
```rust
fn default_streaming_mode() -> String {
    "nano".to_string()
}
```

- [ ] **Step 6: Remove the vestigial assignments in `create_session`**

In `create_session` (`xhome.rs:482-506`), delete:
```rust
        // Determine streaming mode based on what we got
        // We only support WebRTC now
        let streaming_mode = "webrtc".to_string();
```
and
```rust
        // We don't need server IP/port for WebRTC via xHome (it's proxied or handled via ICE)
        let server_ip = None;
        let server_port = None;
```
and in the returned `StreamConfig { ... }` literal delete the three fields `server_ip,`, `server_port,`, and `streaming_mode,`. The struct literal should keep `session_id`, `session_path`, `exchange_response`, `gs_token`, `keep_alive_pulse_seconds`.

- [ ] **Step 7: Turn `nanoVersion` into a documented const**

Above `impl XHomeClient` (or near the top of `xhome.rs`), add:
```rust
/// Transport descriptor the xHome session API expects. Despite the legacy
/// "nano" name, this value configures the WebRTC transport — it never varies.
const NANO_VERSION: &str = "V3;WebrtcTransport.dll";
```
In `create_session`, replace `nano_version: "V3;WebrtcTransport.dll".to_string(),` with `nano_version: NANO_VERSION.to_string(),`.

- [ ] **Step 8: Build and verify the frontend contract is intact**

Run: `cargo build`
Expected: `Finished`, no errors.

Run (must return nothing): `git grep -nE "get_sdp_offer|send_sdp_answer|default_streaming_mode|server_ip|server_port|streaming_mode"`
Expected: no matches in `src/`.

- [ ] **Step 9: Commit**

```bash
git add src/main.rs src/xhome.rs
git commit -m "refactor: remove dead commands, dead fns, and vestigial StreamConfig fields"
```

---

## Task 4: Remove dead dependencies

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Delete the dead dependency lines from `Cargo.toml`**

Remove every one of these lines from `[dependencies]`:
```toml
mdns-sd = "0.11"
trust-dns-resolver = "0.23"
gstreamer = { version = "0.23", optional = true }
gstreamer-video = { version = "0.23", optional = true }
gstreamer-audio = { version = "0.23", optional = true }
gstreamer-app = { version = "0.23", optional = true }
gstreamer-rtp = { version = "0.23", optional = true }
webrtc = "0.11"
webrtc-sdp = "0.3"
oauth2 = "4.4"
url = "2.5"
base64 = "0.22"
urlencoding = "2.1"
bytes = "1.9"
tokio-util = { version = "0.7", features = ["codec"] }
axum = "0.7"
tower-http = { version = "0.6", features = ["cors"] }
futures = "0.3"
anyhow = "1.0"
uuid = { version = "1.0", features = ["v4", "serde"] }
```
Also remove their now-orphaned section comments (`# Video/Audio processing (optional)`, `# WebRTC for Xbox streaming`, `# OAuth2 for Xbox Live authentication`, `# Additional networking`, `# HTTP server for local streaming`, `# UUID generation`). The surviving `[dependencies]` should be: `tauri`, `tauri-plugin-shell`, `serde`, `serde_json`, `tokio`, `reqwest`, `chrono`, `dirs`, `thiserror`, `tracing`, `tracing-subscriber`.

- [ ] **Step 2: Build under the single path**

Run: `cargo build`
Expected: `Finished`. If the compiler reports an unresolved import for any removed crate, that crate was actually used — restore just that one line and note it.

- [ ] **Step 3: Confirm no unused deps remain**

Run: `cargo install cargo-machete --locked` (if not installed), then `cargo machete`
Expected: `cargo-machete didn't find any unused dependencies`.
(If `cargo-machete` is unavailable, use `cargo +nightly udeps` instead.)

- [ ] **Step 4: Prune the lockfile**

Run: `cargo update --workspace` then `cargo build`
Expected: `Cargo.lock` shrinks; build still `Finished`.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: remove 20 unused dependencies"
```

---

## Task 5: OS keychain token storage with migration (TDD)

**Files:**
- Create: `src/token_store.rs`
- Modify: `src/main.rs` (add `mod token_store;`)
- Modify: `src/auth.rs` (use `TokenStore`)
- Modify: `Cargo.toml` (add `keyring`; add `[dev-dependencies] tempfile`)

- [ ] **Step 1: Add dependencies to `Cargo.toml`**

Under `[dependencies]` add (keyring 3.x needs an explicit per-OS backend feature — without one it is a no-op):
```toml
# OS keychain for token storage
keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }
```
Add a new section:
```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Create `src/token_store.rs` with the interface, logic, and tests**

The migration logic is pure, so its tests are written alongside it and exercise it
through an in-memory `MockBackend` (no real keychain). The real OS-backed
`KeyringBackend` is added in Step 4.

```rust
use crate::auth::XboxTokens;
use crate::error::{Result, XboxError};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "xbox-remote";
const KEYRING_USER: &str = "tokens";

/// Abstraction over the OS secret store so migration logic is unit-testable
/// without touching a real keychain.
pub trait SecretBackend {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, secret: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

/// Persists/loads Xbox tokens via a `SecretBackend`, migrating a legacy
/// plaintext JSON file into the keychain on first load if present.
pub struct TokenStore<B: SecretBackend> {
    backend: B,
    legacy_path: Option<PathBuf>,
}

impl<B: SecretBackend> TokenStore<B> {
    pub fn new(backend: B, legacy_path: Option<PathBuf>) -> Self {
        Self { backend, legacy_path }
    }

    pub fn load(&self) -> Result<Option<XboxTokens>> {
        if let Some(secret) = self.backend.get()? {
            let tokens = serde_json::from_str(&secret)
                .map_err(|e| XboxError::AuthError(format!("corrupt keychain tokens: {e}")))?;
            return Ok(Some(tokens));
        }
        self.migrate_from_legacy()
    }

    pub fn save(&self, tokens: &XboxTokens) -> Result<()> {
        let secret = serde_json::to_string(tokens)
            .map_err(|e| XboxError::AuthError(format!("serialize tokens: {e}")))?;
        self.backend.set(&secret)
    }

    pub fn clear(&self) -> Result<()> {
        self.backend.delete()
    }

    /// Migration policy: a parseable legacy file is imported then DELETED.
    /// A corrupt/partial legacy file is treated as "no tokens" and LEFT IN
    /// PLACE for manual inspection (never silently destroyed).
    fn migrate_from_legacy(&self) -> Result<Option<XboxTokens>> {
        let Some(path) = self.legacy_path.as_ref() else { return Ok(None) };
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(path)
            .map_err(|e| XboxError::AuthError(format!("read legacy tokens: {e}")))?;
        match serde_json::from_str::<XboxTokens>(&contents) {
            Ok(tokens) => {
                self.save(&tokens)?;
                let _ = std::fs::remove_file(path);
                tracing::info!("Migrated tokens from legacy plaintext file to OS keychain");
                Ok(Some(tokens))
            }
            Err(e) => {
                tracing::warn!("Legacy token file present but unparseable ({e}); leaving it in place");
                Ok(None)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use std::cell::RefCell;

    /// In-memory backend for tests — no real keychain involved.
    struct MockBackend {
        slot: RefCell<Option<String>>,
    }
    impl MockBackend {
        fn empty() -> Self { Self { slot: RefCell::new(None) } }
        fn with(secret: &str) -> Self { Self { slot: RefCell::new(Some(secret.to_string())) } }
    }
    impl SecretBackend for MockBackend {
        fn get(&self) -> Result<Option<String>> { Ok(self.slot.borrow().clone()) }
        fn set(&self, secret: &str) -> Result<()> { *self.slot.borrow_mut() = Some(secret.to_string()); Ok(()) }
        fn delete(&self) -> Result<()> { *self.slot.borrow_mut() = None; Ok(()) }
    }

    fn sample_tokens() -> XboxTokens {
        XboxTokens {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            xsts_token: "x".into(),
            user_hash: "uhs".into(),
            expires_at: Utc::now() + Duration::hours(1),
        }
    }

    #[test]
    fn loads_from_keychain_without_migrating() {
        let secret = serde_json::to_string(&sample_tokens()).unwrap();
        let store = TokenStore::new(MockBackend::with(&secret), None);
        let loaded = store.load().unwrap().expect("tokens present");
        assert_eq!(loaded.access_token, "a");
    }

    #[test]
    fn migrates_legacy_file_then_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("xbox_tokens.json");
        std::fs::write(&legacy, serde_json::to_string(&sample_tokens()).unwrap()).unwrap();

        let backend = MockBackend::empty();
        let store = TokenStore::new(backend, Some(legacy.clone()));
        let loaded = store.load().unwrap().expect("migrated tokens");

        assert_eq!(loaded.xsts_token, "x");
        assert!(!legacy.exists(), "legacy file should be deleted after migration");
        // And it is now in the keychain for next time:
        assert!(store.backend.get().unwrap().is_some());
    }

    #[test]
    fn corrupt_legacy_file_is_left_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("xbox_tokens.json");
        std::fs::write(&legacy, "{ not valid json").unwrap();

        let store = TokenStore::new(MockBackend::empty(), Some(legacy.clone()));
        let loaded = store.load().unwrap();

        assert!(loaded.is_none());
        assert!(legacy.exists(), "corrupt legacy file must NOT be deleted");
    }

    #[test]
    fn no_keychain_and_no_legacy_returns_none() {
        let store = TokenStore::new(MockBackend::empty(), None);
        assert!(store.load().unwrap().is_none());
    }

    #[test]
    fn save_then_clear_round_trips() {
        let store = TokenStore::new(MockBackend::empty(), None);
        store.save(&sample_tokens()).unwrap();
        assert!(store.load().unwrap().is_some());
        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
    }
}
```

- [ ] **Step 3: Register the module and run the logic tests (they should PASS)**

Add `mod token_store;` to `src/main.rs` (with the other `mod` declarations).

Run: `cargo test token_store`
Expected: 5 tests PASS. They validate load/migrate/corrupt-file/empty/round-trip
behavior entirely through `MockBackend` — no real keychain is touched. The real
`KeyringBackend` is added next so the app can use the keychain at runtime.

- [ ] **Step 4: Add the real `KeyringBackend` to `src/token_store.rs`**

Append (above the `#[cfg(test)]` module):

```rust
/// Real backend backed by the OS keychain via the `keyring` crate.
pub struct KeyringBackend {
    entry: keyring::Entry,
}

impl KeyringBackend {
    pub fn new() -> Result<Self> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| XboxError::AuthError(format!("keychain init failed: {e}")))?;
        Ok(Self { entry })
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self) -> Result<Option<String>> {
        match self.entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(XboxError::AuthError(format!("keychain read failed: {e}"))),
        }
    }
    fn set(&self, secret: &str) -> Result<()> {
        self.entry
            .set_password(secret)
            .map_err(|e| XboxError::AuthError(format!("keychain write failed: {e}")))
    }
    fn delete(&self) -> Result<()> {
        match self.entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(XboxError::AuthError(format!("keychain delete failed: {e}"))),
        }
    }
}
```

> NOTE: confirm the installed `keyring` 3.x API — the delete method is `delete_credential()` in 3.x (it was `delete_password()` in 2.x). `cargo build` is the gate.

- [ ] **Step 5: Build to confirm the real keychain backend compiles**

Run: `cargo build`
Expected: `Finished`. This proves the `keyring` 3.x features resolve on your platform
and `KeyringBackend` compiles (the `delete_credential` method name is correct for 3.x).
If it fails to link a backend, re-check the `keyring` feature flags in Step 1.

- [ ] **Step 6: Rewire `src/auth.rs` to use `TokenStore`**

Add imports near the top:
```rust
use crate::token_store::{KeyringBackend, TokenStore};
```
Rename `get_cache_path` → `legacy_cache_path` (same body) and add a constructor helper:
```rust
    /// Path to the pre-keychain plaintext token file (used only for one-time migration).
    fn legacy_cache_path() -> Option<PathBuf> {
        dirs::config_dir().map(|p| p.join("xbox-remote").join(TOKEN_CACHE_FILE))
    }

    fn token_store() -> Result<TokenStore<KeyringBackend>> {
        Ok(TokenStore::new(KeyringBackend::new()?, Self::legacy_cache_path()))
    }
```
Replace the body of `load_cached_tokens` so it reads from the store (keeping the existing expiry/refresh logic):
```rust
    pub async fn load_cached_tokens(&self) -> Result<bool> {
        let store = Self::token_store()?;
        let tokens = match store.load()? {
            Some(t) => t,
            None => return Ok(false),
        };

        if tokens.expires_at > Utc::now() + chrono::Duration::minutes(5) {
            info!("Cached tokens are still valid");
            *self.tokens.lock().await = Some(tokens);
            return Ok(true);
        }

        if let Some(ref refresh_token) = tokens.refresh_token {
            info!("Cached tokens expired, attempting refresh...");
            match self.refresh_tokens(refresh_token).await {
                Ok(()) => return Ok(true),
                Err(e) => {
                    warn!("Failed to refresh tokens: {}", e);
                    let _ = store.clear();
                }
            }
        }
        Ok(false)
    }
```
Replace the body of `save_tokens_to_cache`:
```rust
    async fn save_tokens_to_cache(&self) -> Result<()> {
        let tokens = self.tokens.lock().await;
        if let Some(ref tokens) = *tokens {
            Self::token_store()?.save(tokens)?;
            info!("Saved tokens to OS keychain");
        }
        Ok(())
    }
```

- [ ] **Step 7: Build, test, and smoke-test the migration**

Run: `cargo build` → Expected: `Finished`.
Run: `cargo test` → Expected: all tests pass.
Manual: with a pre-existing `~/<config>/xbox-remote/xbox_tokens.json` present, launch `cargo run`, sign in (or load cached), then confirm the plaintext file is **gone** and auth survives an app restart.

- [ ] **Step 8: Commit**

```bash
git add Cargo.toml Cargo.lock src/main.rs src/token_store.rs src/auth.rs
git commit -m "feat: store tokens in the OS keychain with one-time plaintext migration"
```

---

## Task 6: Externalize the Azure client ID (TDD)

**Files:**
- Modify: `src/auth.rs`

- [ ] **Step 1: Write a failing test for the resolver**

Add to the bottom of `src/auth.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_env_value_when_present() {
        assert_eq!(resolve_client_id_from(Some("custom-id".to_string())), "custom-id");
    }

    #[test]
    fn falls_back_to_default_when_absent() {
        assert_eq!(resolve_client_id_from(None), DEFAULT_CLIENT_ID);
    }
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cargo test falls_back_to_default_when_absent`
Expected: COMPILE ERROR — `resolve_client_id_from` and `DEFAULT_CLIENT_ID` are not defined yet.

- [ ] **Step 3: Implement the resolver and replace the const**

Replace the `const CLIENT_ID...` block (lines 10–13) with:
```rust
/// Default Azure AD app client ID for Xbox Live authentication.
/// Override at runtime with the XBOX_CLIENT_ID environment variable.
/// Register at https://portal.azure.com -> App registrations (enable
/// "Allow public client flows" in Authentication settings).
const DEFAULT_CLIENT_ID: &str = "6f40db01-bee0-49fc-8f48-fa29e949426e";

/// Pure resolver (testable): env value if present, else the default.
fn resolve_client_id_from(env: Option<String>) -> String {
    env.filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string())
}

/// Resolve the client ID, honoring the XBOX_CLIENT_ID env override.
fn resolve_client_id() -> String {
    resolve_client_id_from(std::env::var("XBOX_CLIENT_ID").ok())
}
```

- [ ] **Step 4: Use the resolver at the three call sites**

In `refresh_tokens`, `start_device_code_auth`, and `poll_for_token`, replace each `("client_id", CLIENT_ID),` with a local binding so the borrow lives long enough:
```rust
        let client_id = resolve_client_id();
        let params = [
            ("client_id", client_id.as_str()),
            // ...remaining params unchanged...
        ];
```
(Apply to all three `params` arrays that previously used `CLIENT_ID`.)

- [ ] **Step 5: Run tests and build**

Run: `cargo test` → Expected: the two new tests pass, all others still pass.
Run: `cargo build` → Expected: `Finished`.

- [ ] **Step 6: Commit**

```bash
git add src/auth.rs
git commit -m "feat: allow overriding the Azure client ID via XBOX_CLIENT_ID env var"
```

---

## Task 7: Modernize — edition 2024 + dependency refresh

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Confirm the toolchain supports edition 2024**

Run: `rustc --version`
Expected: ≥ 1.85.0. If older, run `rustup update stable`. If you cannot update, SKIP the edition bump (keep `edition = "2021"`) and do only Step 3; note it in the commit.

- [ ] **Step 2: Bump the edition**

In `Cargo.toml` set:
```toml
edition = "2024"
```
Run: `cargo build` then `cargo clippy --all-targets`
Expected: `Finished`; fix any edition-2024 lints the compiler reports (most commonly `unsafe` attribute or closure-capture changes — unlikely in this codebase).

- [ ] **Step 3: Refresh remaining dependency versions**

Run: `cargo upgrade --incompatible` (from `cargo-edit`; install with `cargo install cargo-edit --locked` if needed) to bump `tauri`, `reqwest`, `tokio`, `serde`, `chrono`, `tracing*`, `thiserror`, `dirs`, `keyring` to current majors. If `cargo-edit` is unavailable, bump versions by hand conservatively.
Run: `cargo build && cargo test`
Expected: `Finished`; all tests pass. If a major bump breaks a call site, pin that one crate back and note it.

- [ ] **Step 4: Smoke-test the app**

Run: `cargo run`
Expected: app launches; sign-in + console list still work.

- [ ] **Step 5: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore: move to Rust edition 2024 and refresh dependency versions"
```

---

## Task 8: Documentation consolidation (archive-only) + housekeeping

**Files:**
- Create: `docs/history/` (+ `milestones/`, `design-docs/`)
- Move/rename: many `.md` files
- Rewrite: `CLAUDE.md`
- Delete: `nul`; Modify: `.gitignore`

- [ ] **Step 1: Create the archive structure and move superseded docs**

```bash
mkdir -p docs/history/milestones docs/history/design-docs
git mv PHASE_2_COMPLETE.md docs/history/milestones/
git mv docs/plans/2026-03-15-finish-implementation-design.md docs/history/design-docs/
git mv docs/plans/2026-03-15-connection-manager-design.md docs/history/design-docs/
```

- [ ] **Step 2: Merge unique content, then archive the redundant testing/debug docs**

Before moving, copy any unique console-log sequences / manual-test commands from `AUTH_TESTING.md` and `TEST_NOW.md` into `TESTING.md`, and any unique WSL/X11 steps from `BUTTON_DEBUG.md` into `DEBUG_WINDOW.md`. Then:
```bash
git mv AUTH_TESTING.md docs/history/
git mv TEST_NOW.md docs/history/
git mv BUTTON_DEBUG.md docs/history/
```

- [ ] **Step 3: Rename the keeper docs to their consolidated names**

```bash
git mv IMPLEMENTATION_SUMMARY.md TECHNICAL_DETAILS.md
git mv TESTING.md TESTING_GUIDE.md
git mv DEBUG_WINDOW.md TROUBLESHOOTING.md
git mv IMPLEMENTATION_STATUS.md docs/PHASES.md
git mv STREAMING_ARCHITECTURE.md docs/ARCHITECTURE_RESEARCH.md
git mv AZURE_APP_SETUP.md AZURE_SETUP.md
```

- [ ] **Step 4: Rewrite `CLAUDE.md` to the real architecture**

Replace the "Video Streaming Architecture" section and any `src/streaming/`, Nano, GStreamer, MJPEG, port-8080, and local SSDP/SmartGlass references with the true flow. The architecture section should read:
```markdown
## Architecture (cloud Remote Play)

Xbox Remote streams the user's own console from Microsoft's cloud (the xHome /
Remote Play path) over WebRTC. There is NO local Nano/RTP/GStreamer path.

Flow: OAuth device-code (`src/auth.rs`) -> Xbox Live user token -> XSTS (gssv
relying party) -> xHome REST API (`src/xhome.rs`): login + region, list consoles,
create session, exchange SDP, trickle ICE, keepalive. Media + input run over
**browser** WebRTC in `ui/public/app.js` (4 data channels: chat/control/message/input).
Tokens are stored in the OS keychain (`src/token_store.rs`).

Modules: `auth.rs` (OAuth/tokens), `xhome.rs` (cloud signaling), `token_store.rs`
(keychain), `error.rs` (XboxError), `main.rs` (Tauri shell + commands), `ui/public/`
(frontend). Discovery is cloud-only via `discover_xhome_consoles`.
```
Update the build/run section to a single path:
```markdown
## Build & Run

cargo run            # launches the Tauri app (the only mode)
cargo build --release
cargo test

Set `XBOX_CLIENT_ID` to override the default Azure app registration.
Edition: 2024. Target: cross-platform (developed on Windows).
```
Remove the old "CLI Mode (No UI)" and `--features tauri` / `gstreamer-support`
instructions and the "Edition 2024 (ensure compatible Rust version)" pitfall wording
that referenced edition 2021/2024 confusion.

- [ ] **Step 5: Update `README.md` and `START_HERE.md`**

In both: replace any GStreamer/Nano/local-streaming language with the cloud-WebRTC
reality; change run instructions to `cargo run` (no feature flags, no CLI mode); add a
one-line "developed on Windows, targets cross-platform" note. Point links at the renamed
docs (`TECHNICAL_DETAILS.md`, `TESTING_GUIDE.md`, `TROUBLESHOOTING.md`, `AZURE_SETUP.md`).

- [ ] **Step 6: Delete the stray `nul` file and ignore it**

```bash
git rm nul
```
If that fails (Windows reserved name), run in PowerShell: `Remove-Item -LiteralPath '\\?\C:\Projects\xbox-remote\nul' -Force` then `git add -A`.
Append to `.gitignore`:
```
# Windows reserved-name artifact
nul
```
Also archive the now-stale CLI/gstreamer scripts:
```bash
git mv check_xbox.sh docs/history/ 2>/dev/null || true
git mv test_gstreamer.sh docs/history/ 2>/dev/null || true
```

- [ ] **Step 7: Verify no phantom references remain in the live docs**

Run: `git grep -nEi "src/streaming|gstreamer|mjpeg|nano protocol|smartglass|port 8080|--features tauri" -- CLAUDE.md README.md START_HERE.md`
Expected: no matches (matches are allowed only under `docs/history/` and `docs/ARCHITECTURE_RESEARCH.md`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs: consolidate docs (archive-only), rewrite CLAUDE.md to real cloud-WebRTC architecture, remove nul"
```

---

## Final verification (run after all tasks)

- [ ] `cargo build` — `Finished`, single path, no `--features`.
- [ ] `cargo clippy --all-targets` — no new warnings.
- [ ] `cargo machete` — no unused dependencies.
- [ ] `cargo test` — token_store (5) + client-id (2) tests pass.
- [ ] `cargo run` — app launches; device-code sign-in works; cloud console list populates.
- [ ] Tokens live in the OS keychain; any legacy `xbox_tokens.json` migrated and deleted; auth survives restart.
- [ ] `XBOX_CLIENT_ID` override works; unset falls back to default.
- [ ] `git grep -nEi "src/streaming|gstreamer|nano protocol|smartglass"` returns matches only under `docs/history/` and `docs/ARCHITECTURE_RESEARCH.md`.
- [ ] `git grep -nE "XboxDiscovery|get_sdp_offer|default_streaming_mode"` returns nothing.

Maps to spec acceptance criteria §6.1–§6.10 in `docs/superpowers/specs/2026-06-08-foundation-cleanup-design.md`.
