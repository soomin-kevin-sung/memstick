use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShortcutTrigger {
    shortcut: String,
    state: String,
    sequence: u64,
}

#[tauri::command]
fn default_shortcut() -> &'static str {
    DEFAULT_SHORTCUT
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background".into()]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let sequence = app
                        .state::<std::sync::atomic::AtomicU64>()
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                        + 1;
                    let payload = ShortcutTrigger {
                        shortcut: shortcut_to_label(shortcut),
                        state: "pressed".to_string(),
                        sequence,
                    };
                    let _ = app.emit("shortcut-triggered", payload);
                    show_settings_window(app);
                })
                .build(),
        )
        .manage(std::sync::atomic::AtomicU64::new(0))
        .setup(|app| {
            create_tray(app.handle())?;
            register_default_shortcut(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![default_shortcut])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show_settings", "Open settings", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide_settings", "Hide settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit service", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    let mut builder = TrayIconBuilder::with_id("memstick-service")
        .tooltip("Memstick Service POC")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_settings" => show_settings_window(app),
            "hide_settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn register_default_shortcut(
    app: &AppHandle,
) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let shortcut = Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::Space,
    );
    app.global_shortcut().register(shortcut)?;
    Ok(())
}

fn show_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn shortcut_to_label(shortcut: &Shortcut) -> String {
    format!("{shortcut:?}")
}
