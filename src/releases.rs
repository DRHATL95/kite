//! GitHub release history for the in-app About view. Fetches the repo's public
//! Releases API (anonymous — works once the repo is public) and returns a
//! trimmed set of fields; the frontend shapes/filters them (releaseNotes.ts).

use serde::{Deserialize, Serialize};

/// Subset of a GitHub Releases API entry needed by the About view.
#[derive(Serialize, Deserialize)]
pub struct RawRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub prerelease: bool,
}

const RELEASES_URL: &str = "https://api.github.com/repos/DRHATL95/kite/releases";

/// Fetch the repo's releases from the GitHub API. Anonymous; requires the repo
/// to be public. Returns the raw list for the frontend to shape (`selectReleases`).
#[tauri::command]
pub async fn get_releases() -> Result<Vec<RawRelease>, String> {
    let resp = reqwest::Client::new()
        .get(RELEASES_URL)
        // GitHub's API rejects requests without a User-Agent.
        .header("User-Agent", "kite")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("release fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API returned {}", resp.status()));
    }
    resp.json::<Vec<RawRelease>>()
        .await
        .map_err(|e| format!("release parse failed: {e}"))
}
