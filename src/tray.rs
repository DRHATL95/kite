//! System-tray icon + menu (always-on). The tray restores the window (hidden by
//! the frontend close-to-tray handler) and offers Show/Quit. `tray_action` is a
//! pure menu-id → action mapping, unit-tested; `build_tray` is Tauri glue.

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

    let mut builder = TrayIconBuilder::new()
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

    // Reuse the bundled app icon (no new asset) when one is available.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
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
}
