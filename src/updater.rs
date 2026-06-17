//! In-app update channel support: maps the selected channel to its rolling
//! latest.json endpoint and runs the check/install against it. See
//! docs/superpowers/specs/2026-06-13-update-channel-selector-sp2-design.md

/// Map a channel name to its rolling latest.json endpoint URL.
/// Unknown values fall back to the stable channel (safe default).
pub fn channel_endpoint(channel: &str) -> String {
    let ch = if channel == "nightly" { "nightly" } else { "stable" };
    format!("https://github.com/DRHATL95/xbox-remote-releases/releases/download/{ch}/latest.json")
}

use std::sync::Mutex;
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

/// Holds the pending update between `check_update` and `install_update`.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

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
        // Accept any version that differs from the current (enables downgrade on channel switch).
        builder = builder.version_comparator(|current, release| release.version.to_string() != current.to_string());
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
            |chunk_size, total| {
                if !started {
                    let _ = on_event.send(DownloadEvent::Started { content_length: total });
                    started = true;
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length: chunk_size });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    app.restart();
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

    #[test]
    fn uses_github_releases_host() {
        let url = channel_endpoint("stable");
        assert!(
            url.starts_with("https://github.com/DRHATL95/xbox-remote-releases/releases/download/"),
            "unexpected endpoint host: {url}"
        );
    }
}
