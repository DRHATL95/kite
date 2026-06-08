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
                tracing::warn!("Legacy token file present but unparseable ({e}); leaving it in place");
                Ok(None)
            }
        }
    }
}

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
