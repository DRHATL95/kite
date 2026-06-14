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
