use crate::auth::XboxTokens;
use crate::error::{Result, XboxError};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "kite";
const KEYRING_USER: &str = "tokens";

/// Max chars per keychain entry. Windows Credential Manager caps a single
/// credential's UTF-16 secret blob at 2560 bytes (~1280 BMP chars). The
/// serialized token bundle (long XSTS/access JWTs) exceeds that, so it is split
/// across multiple entries. 1024 chars ≈ 2048 UTF-16 bytes — safely under the limit.
const CHUNK_CHARS: usize = 1024;

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
        Self {
            backend,
            legacy_path,
        }
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
        let Some(path) = self.legacy_path.as_ref() else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }
        let contents = std::fs::read_to_string(path)
            .map_err(|e| XboxError::AuthError(format!("read legacy tokens: {e}")))?;
        match serde_json::from_str::<XboxTokens>(&contents) {
            Ok(tokens) => {
                self.save(&tokens)?;
                // The whole point of migration is to stop storing tokens in
                // plaintext, so a failure to delete the legacy file must be
                // surfaced loudly rather than swallowed.
                if let Err(e) = std::fs::remove_file(path) {
                    tracing::warn!(
                        "Migrated tokens to the OS keychain, but FAILED to delete the legacy \
                         plaintext token file at {}: {e}. Delete it manually.",
                        path.display()
                    );
                } else {
                    tracing::info!("Migrated tokens from legacy plaintext file to OS keychain");
                }
                Ok(Some(tokens))
            }
            Err(e) => {
                tracing::warn!(
                    "Legacy token file present but unparseable ({e}); leaving it in place"
                );
                Ok(None)
            }
        }
    }
}

/// Low-level key→secret store: one OS keychain credential per key. Abstracted
/// so the chunking logic can be unit-tested against a mock that simulates the
/// Windows per-entry size limit (the exact failure that motivated chunking).
trait KvSecret {
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn set(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}

fn chunk_key(base: &str, i: usize) -> String {
    format!("{base}.{i}")
}

/// Split a string into chunks of at most `size` chars (never mid-char).
fn split_chunks(s: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    chars.chunks(size).map(|c| c.iter().collect()).collect()
}

/// Read a chunked secret: the `base` entry holds the chunk count; chunks live in
/// `base.0`, `base.1`, … Returns None if the base entry is absent.
fn kv_get_chunked<K: KvSecret>(kv: &K, base: &str) -> Result<Option<String>> {
    let count_str = match kv.get(base)? {
        Some(s) => s,
        None => return Ok(None),
    };
    let count: usize = count_str.trim().parse().map_err(|_| {
        XboxError::AuthError(format!("keychain corrupt chunk count: {count_str:?}"))
    })?;
    let mut out = String::new();
    for i in 0..count {
        let chunk = kv
            .get(&chunk_key(base, i))?
            .ok_or_else(|| XboxError::AuthError(format!("keychain missing chunk {i}")))?;
        out.push_str(&chunk);
    }
    Ok(Some(out))
}

/// Write a chunked secret. The base count is invalidated FIRST and written LAST,
/// so a partial failure reads as "no tokens" rather than a corrupt old+new mix.
fn kv_set_chunked<K: KvSecret>(kv: &K, base: &str, secret: &str, chunk_chars: usize) -> Result<()> {
    let old_count = kv
        .get(base)?
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    kv.delete(base)?; // secret is "absent" during the rewrite
    let chunks = split_chunks(secret, chunk_chars);
    for (i, c) in chunks.iter().enumerate() {
        kv.set(&chunk_key(base, i), c)?;
    }
    for i in chunks.len()..old_count {
        kv.delete(&chunk_key(base, i))?; // drop stale higher chunks from a larger prior write
    }
    kv.set(base, &chunks.len().to_string())?; // commit: secret is now present
    Ok(())
}

/// Delete a chunked secret (base count + all its chunks).
fn kv_delete_chunked<K: KvSecret>(kv: &K, base: &str) -> Result<()> {
    let count = kv
        .get(base)?
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    kv.delete(base)?;
    for i in 0..count {
        kv.delete(&chunk_key(base, i))?;
    }
    Ok(())
}

/// Real `KvSecret` backed by the OS keychain via the `keyring` crate.
struct KeyringKv;

impl KvSecret for KeyringKv {
    fn get(&self, key: &str) -> Result<Option<String>> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|e| XboxError::AuthError(format!("keychain init failed: {e}")))?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(XboxError::AuthError(format!("keychain read failed: {e}"))),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|e| XboxError::AuthError(format!("keychain init failed: {e}")))?;
        entry
            .set_password(value)
            .map_err(|e| XboxError::AuthError(format!("keychain write failed: {e}")))
    }
    fn delete(&self, key: &str) -> Result<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key)
            .map_err(|e| XboxError::AuthError(format!("keychain init failed: {e}")))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(XboxError::AuthError(format!("keychain delete failed: {e}"))),
        }
    }
}

/// Real backend backed by the OS keychain, chunking the secret across multiple
/// credentials to stay under the Windows Credential Manager per-entry size limit.
pub struct KeyringBackend {
    kv: KeyringKv,
}

impl KeyringBackend {
    pub fn new() -> Result<Self> {
        // Probe that a keychain entry can be constructed (surfaces backend issues early).
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| XboxError::AuthError(format!("keychain init failed: {e}")))?;
        Ok(Self { kv: KeyringKv })
    }
}

impl SecretBackend for KeyringBackend {
    fn get(&self) -> Result<Option<String>> {
        kv_get_chunked(&self.kv, KEYRING_USER)
    }
    fn set(&self, secret: &str) -> Result<()> {
        kv_set_chunked(&self.kv, KEYRING_USER, secret, CHUNK_CHARS)
    }
    fn delete(&self) -> Result<()> {
        kv_delete_chunked(&self.kv, KEYRING_USER)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// In-memory backend for tests — no real keychain involved.
    struct MockBackend {
        slot: RefCell<Option<String>>,
    }
    impl MockBackend {
        fn empty() -> Self {
            Self {
                slot: RefCell::new(None),
            }
        }
        fn with(secret: &str) -> Self {
            Self {
                slot: RefCell::new(Some(secret.to_string())),
            }
        }
    }
    impl SecretBackend for MockBackend {
        fn get(&self) -> Result<Option<String>> {
            Ok(self.slot.borrow().clone())
        }
        fn set(&self, secret: &str) -> Result<()> {
            *self.slot.borrow_mut() = Some(secret.to_string());
            Ok(())
        }
        fn delete(&self) -> Result<()> {
            *self.slot.borrow_mut() = None;
            Ok(())
        }
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
        assert!(
            !legacy.exists(),
            "legacy file should be deleted after migration"
        );
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

    /// Mock key→secret store that simulates the Windows Credential Manager
    /// per-entry size limit — the exact failure that motivated chunking.
    struct MockKv {
        store: RefCell<HashMap<String, String>>,
        limit_utf16_bytes: usize,
    }
    impl MockKv {
        fn new(limit_utf16_bytes: usize) -> Self {
            Self {
                store: RefCell::new(HashMap::new()),
                limit_utf16_bytes,
            }
        }
    }
    impl KvSecret for MockKv {
        fn get(&self, key: &str) -> Result<Option<String>> {
            Ok(self.store.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<()> {
            let utf16_bytes = value.encode_utf16().count() * 2;
            if utf16_bytes > self.limit_utf16_bytes {
                return Err(XboxError::AuthError(format!(
                    "mock keychain: value {utf16_bytes} bytes exceeds limit {}",
                    self.limit_utf16_bytes
                )));
            }
            self.store
                .borrow_mut()
                .insert(key.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<()> {
            self.store.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn split_chunks_roundtrips_and_bounds_size() {
        let big = "a".repeat(5000);
        let chunks = split_chunks(&big, CHUNK_CHARS);
        assert!(chunks.len() >= 5);
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_CHARS));
        assert_eq!(chunks.concat(), big);
        assert_eq!(split_chunks("", CHUNK_CHARS), vec![String::new()]);
    }

    #[test]
    fn chunked_write_stores_oversized_secret_under_per_entry_limit() {
        // ~6000 chars (12000 UTF-16 bytes): a single Windows credential (2560
        // bytes) could NOT hold this. REGRESSION TEST — the old single-entry
        // backend errored here; chunking must succeed and round-trip.
        let kv = MockKv::new(2560);
        let big = "x".repeat(6000);
        kv_set_chunked(&kv, "tokens", &big, CHUNK_CHARS)
            .expect("chunked write must succeed by staying under the per-entry limit");
        for (k, v) in kv.store.borrow().iter() {
            assert!(
                v.encode_utf16().count() * 2 <= 2560,
                "entry {k} exceeds the per-entry limit"
            );
        }
        assert_eq!(kv_get_chunked(&kv, "tokens").unwrap().unwrap(), big);
    }

    #[test]
    fn chunked_overwrite_with_smaller_secret_drops_stale_chunks() {
        let kv = MockKv::new(2560);
        kv_set_chunked(&kv, "tokens", &"a".repeat(5000), CHUNK_CHARS).unwrap();
        kv_set_chunked(&kv, "tokens", &"b".repeat(300), CHUNK_CHARS).unwrap();
        assert_eq!(
            kv_get_chunked(&kv, "tokens").unwrap().unwrap(),
            "b".repeat(300)
        );
        assert!(
            kv.store.borrow().get("tokens.1").is_none(),
            "stale higher chunk must be removed"
        );
    }

    #[test]
    fn chunked_delete_clears_base_and_all_chunks() {
        let kv = MockKv::new(2560);
        kv_set_chunked(&kv, "tokens", &"a".repeat(3000), CHUNK_CHARS).unwrap();
        kv_delete_chunked(&kv, "tokens").unwrap();
        assert!(kv_get_chunked(&kv, "tokens").unwrap().is_none());
        assert!(
            kv.store.borrow().is_empty(),
            "no orphan chunks should remain"
        );
    }

    #[test]
    fn realistic_token_bundle_exceeds_single_entry_and_chunks() {
        // JWT-sized fields serialize well past 2560 bytes — why chunking is required.
        let tokens = XboxTokens {
            access_token: "A".repeat(1400),
            refresh_token: Some("R".repeat(900)),
            xsts_token: "X".repeat(2000),
            user_hash: "uhs1234567890".into(),
            expires_at: Utc::now() + Duration::hours(1),
        };
        let json = serde_json::to_string(&tokens).unwrap();
        assert!(
            json.encode_utf16().count() * 2 > 2560,
            "fixture must exceed the single-entry limit"
        );
        let kv = MockKv::new(2560);
        kv_set_chunked(&kv, "tokens", &json, CHUNK_CHARS).unwrap();
        let restored: XboxTokens =
            serde_json::from_str(&kv_get_chunked(&kv, "tokens").unwrap().unwrap()).unwrap();
        assert_eq!(restored.xsts_token, tokens.xsts_token);
        assert_eq!(restored.access_token, tokens.access_token);
    }
}
