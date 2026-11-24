//! The Windows notification-area icon. Closing the main window on Windows hides it, as on macOS, so terminals and
//! agents keep running; this icon brings the window back (left click or "Show Tessera") and quits the app ("Quit
//! Tessera"). Starting Tessera again while it runs also shows the window (the single-instance plugin in `lib.rs`).
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

const SHOW: &str = "tray.show";
const QUIT: &str = "tray.quit";

fn show(app: &tauri::AppHandle) {
    if let Err(error) = crate::native_commands::window_focus_main(app.clone()) {
        tracing::warn!(code = %error.code, "could not show the main window");
    }
}

/// Adds the icon. A failure is logged and the app runs without it.
pub fn install(app: &tauri::App) {
    let built = (|| -> tauri::Result<()> {
        let show_item = MenuItem::with_id(app, SHOW, "Show Tessera", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, QUIT, "Quit Tessera", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
        let mut builder = TrayIconBuilder::with_id("main")
            .tooltip("Tessera")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                SHOW => show(app),
                QUIT => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    show(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })();
    if let Err(error) = built {
        tracing::warn!(%error, "could not add the notification-area icon");
    }
}

/// Brings the running app forward when Tessera is started again.
pub fn second_start(app: &tauri::AppHandle) {
    show(app);
}
