//! System-tray icon + menu (always-on). The tray restores the window (hidden by
//! the frontend close-to-tray handler) and offers Show/Quit. `tray_action` is a
//! pure menu-id → action mapping, unit-tested; `build_tray` is Tauri glue.

const KITE_MIDNIGHT: &[u8] = include_bytes!("../icons/tray/kite-midnight.png");
const KITE_CARBON: &[u8] = include_bytes!("../icons/tray/kite-carbon.png");
const KITE_SYNTH: &[u8] = include_bytes!("../icons/tray/kite-synth.png");
const KITE_EMBER: &[u8] = include_bytes!("../icons/tray/kite-ember.png");
const KITE_PAPER: &[u8] = include_bytes!("../icons/tray/kite-paper.png");

/// Map a theme id to its embedded tray PNG. Unknown ids fall back to the
/// default (`midnight`), mirroring the frontend's THEME_IDS guard.
fn icon_bytes_for(theme_id: &str) -> &'static [u8] {
    match theme_id {
        "carbon" => KITE_CARBON,
        "synth" => KITE_SYNTH,
        "ember" => KITE_EMBER,
        "paper" => KITE_PAPER,
        _ => KITE_MIDNIGHT,
    }
}

/// Decode an embedded PNG into an owned Tauri image (RGBA). Non-fatal: a decode
/// failure (only possible if a committed asset is corrupt) logs and returns None.
fn decode_icon(bytes: &[u8]) -> Option<tauri::image::Image<'static>> {
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            Some(tauri::image::Image::new_owned(rgba.into_raw(), w, h))
        }
        Err(e) => {
            tracing::warn!("tray icon decode failed: {e}");
            None
        }
    }
}

/// What a tray menu item does.
#[derive(Debug, PartialEq, Eq)]
pub enum TrayAction {
    /// Restore + focus the main window.
    Show,
    /// Quit the whole app.
    Quit,
}

/// Map a tray menu item id to its action. Unknown ids → `None`.
pub fn tray_action(menu_id: &str) -> Option<TrayAction> {
    match menu_id {
        "show" => Some(TrayAction::Show),
        "quit" => Some(TrayAction::Quit),
        _ => None,
    }
}

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Swap the tray icon to the tint for `theme`. Called by the frontend on theme
/// change (and once at startup). Non-fatal: no-ops when there is no tray or the
/// asset can't be decoded.
#[tauri::command]
pub fn set_tray_theme(app: tauri::AppHandle, theme: String) {
    if let (Some(tray), Some(icon)) = (
        app.tray_by_id("kite-tray"),
        decode_icon(icon_bytes_for(&theme)),
    )
        && let Err(e) = tray.set_icon(Some(icon))
    {
        tracing::warn!("set_tray_theme: set_icon failed: {e}");
    }
}

/// Show, unminimize, and focus the main window (best-effort).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Build the always-on tray icon: reuse the bundled window icon, tooltip "Kite",
/// a Show/Quit menu, and left-click-to-restore. Never fatal — callers log and
/// continue so a tray failure only means "close quits" (as if the feature were off).
pub fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Kite", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Kite", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("kite-tray")
        .tooltip("Kite")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_action(event.id.as_ref()) {
            Some(TrayAction::Show) => show_main(app),
            Some(TrayAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // Start with the default (midnight) themed icon; the frontend's
    // themeStore.init() fires set_tray_theme() on load to match the saved theme.
    if let Some(icon) = decode_icon(icon_bytes_for("midnight")) {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_menu_ids_and_ignores_others() {
        assert_eq!(tray_action("show"), Some(TrayAction::Show));
        assert_eq!(tray_action("quit"), Some(TrayAction::Quit));
        assert_eq!(tray_action("bogus"), None);
    }

    #[test]
    fn icon_bytes_maps_themes_and_defaults_unknown_to_midnight() {
        assert_eq!(icon_bytes_for("carbon"), KITE_CARBON);
        assert_eq!(icon_bytes_for("synth"), KITE_SYNTH);
        assert_eq!(icon_bytes_for("ember"), KITE_EMBER);
        assert_eq!(icon_bytes_for("paper"), KITE_PAPER);
        assert_eq!(icon_bytes_for("midnight"), KITE_MIDNIGHT);
        assert_eq!(icon_bytes_for("nonsense"), KITE_MIDNIGHT);
    }
}
