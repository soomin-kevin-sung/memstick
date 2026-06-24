use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+Space";
const MAX_TREE_DEPTH: usize = 8;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutTrigger {
    shortcut: String,
    state: String,
    sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeStatus {
    native_ready: bool,
    shortcut_registered: bool,
    default_shortcut: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownTreeNode {
    kind: &'static str,
    name: String,
    path: String,
    children: Vec<MarkdownTreeNode>,
}

#[tauri::command]
fn native_status(state: tauri::State<'_, RuntimeState>) -> NativeStatus {
    NativeStatus {
        native_ready: true,
        shortcut_registered: state.shortcut_registered.load(Ordering::Relaxed),
        default_shortcut: DEFAULT_SHORTCUT,
    }
}

struct RuntimeState {
    shortcut_registered: AtomicBool,
    shortcut_trigger_count: AtomicU64,
    note_window_sequence: AtomicU64,
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    show_window(&app);
}

#[tauri::command]
fn hide_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn toggle_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_window(&app),
        }
    }
}

#[tauri::command]
fn scan_markdown_tree(root: Option<String>) -> Result<Vec<MarkdownTreeNode>, String> {
    let root = match root {
        Some(root) => PathBuf::from(root),
        None => default_notes_dir()?,
    };

    if !root.exists() {
        return Ok(Vec::new());
    }

    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }

    scan_directory(&root, &root, 0)
}

#[tauri::command]
fn read_markdown_file(relative_path: String) -> Result<String, String> {
    let path = resolve_note_path(&relative_path)?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 1_000_000 {
        return Err("file is too large for the baseline editor".to_string());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_markdown_file(relative_path: String, content: String) -> Result<(), String> {
    if content.len() > 1_000_000 {
        return Err("content is too large for the baseline editor".to_string());
    }
    let path = resolve_note_path(&relative_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_workspace_state(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = workspace_state_file(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_workspace_state(app: AppHandle, state: serde_json::Value) -> Result<(), String> {
    let path = workspace_state_file(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

#[tauri::command]
fn open_markdown_window(
    app: AppHandle,
    state: tauri::State<'_, RuntimeState>,
    relative_path: String,
    opacity: Option<u8>,
    always_on_top: Option<bool>,
) -> Result<String, String> {
    let path = resolve_note_path(&relative_path)?;
    if !path.exists() {
        return Err(format!("markdown file not found: {relative_path}"));
    }

    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid markdown file name".to_string())?
        .to_string();
    let label = note_window_label(&relative_path);

    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|error| error.to_string())?;
    }

    let sequence = state.note_window_sequence.fetch_add(1, Ordering::Relaxed);
    let x = 120.0 + f64::from((sequence % 5) as u8) * 42.0;
    let y = 120.0 + f64::from((sequence % 6) as u8) * 36.0;
    let opacity = opacity.unwrap_or(100).clamp(35, 100);
    let always_on_top = always_on_top.unwrap_or(true);

    open_note_window_at(
        &app,
        &label,
        &title,
        &relative_path,
        x,
        y,
        520.0,
        420.0,
        opacity,
        always_on_top,
    )?;
    Ok(label)
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.show().map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "settings", page_url("settings.html")?)
        .title("Memstick Settings")
        .inner_size(460.0, 420.0)
        .min_inner_size(420.0, 360.0)
        .resizable(false)
        .decorations(true)
        .always_on_top(false)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[derive(Clone, Copy)]
struct NoteWindowSpec {
    label: &'static str,
    title: &'static str,
    relative_path: &'static str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    opacity: u8,
}

const DEMO_NOTE_WINDOWS: [NoteWindowSpec; 3] = [
    NoteWindowSpec {
        label: "note-weekly-sync",
        title: "weekly-sync.md",
        relative_path: "Work/weekly-sync.md",
        x: 120.0,
        y: 120.0,
        width: 520.0,
        height: 420.0,
        opacity: 100,
    },
    NoteWindowSpec {
        label: "note-release",
        title: "release-0.3.md",
        relative_path: "Work/release-0.3.md",
        x: 680.0,
        y: 150.0,
        width: 520.0,
        height: 390.0,
        opacity: 100,
    },
    NoteWindowSpec {
        label: "note-scratch",
        title: "scratch-pad.md",
        relative_path: "Capture/scratch-pad.md",
        x: 420.0,
        y: 560.0,
        width: 460.0,
        height: 260.0,
        opacity: 55,
    },
];

#[tauri::command]
async fn open_demo_note_windows(app: AppHandle) -> Result<Vec<String>, String> {
    let mut opened = Vec::new();

    for spec in DEMO_NOTE_WINDOWS {
        open_note_window(&app, spec)?;
        opened.push(spec.label.to_string());
    }

    Ok(opened)
}

#[tauri::command]
fn set_note_window_visible(app: AppHandle, label: String, visible: bool) -> Result<(), String> {
    ensure_note_window_label(&label)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;

    if visible {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn set_note_window_always_on_top(
    app: AppHandle,
    label: String,
    always_on_top: bool,
) -> Result<(), String> {
    ensure_note_window_label(&label)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_note_window_click_through(
    app: AppHandle,
    label: String,
    click_through: bool,
) -> Result<(), String> {
    ensure_note_window_label(&label)?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window not found: {label}"))?;
    window
        .set_ignore_cursor_events(click_through)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }

                    let sequence = app
                        .state::<RuntimeState>()
                        .shortcut_trigger_count
                        .fetch_add(1, Ordering::Relaxed)
                        + 1;
                    let _ = app.emit(
                        "shortcut-triggered",
                        ShortcutTrigger {
                            shortcut: shortcut_to_label(shortcut),
                            state: "pressed".to_string(),
                            sequence,
                        },
                    );
                    show_window(app);
                })
                .build(),
        )
        .manage(RuntimeState {
            shortcut_registered: AtomicBool::new(false),
            shortcut_trigger_count: AtomicU64::new(0),
            note_window_sequence: AtomicU64::new(0),
        })
        .setup(|app| {
            create_tray(app.handle())?;
            let shortcut_registered = register_default_shortcut(app.handle()).is_ok();
            app.state::<RuntimeState>()
                .shortcut_registered
                .store(shortcut_registered, Ordering::Relaxed);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with("note-") {
                    let _ = window.destroy();
                } else {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            native_status,
            show_main_window,
            hide_main_window,
            toggle_main_window,
            scan_markdown_tree,
            read_markdown_file,
            write_markdown_file,
            open_markdown_window,
            open_settings_window,
            load_workspace_state,
            save_workspace_state,
            open_demo_note_windows,
            set_note_window_visible,
            set_note_window_always_on_top,
            set_note_window_click_through
        ])
        .run(tauri::generate_context!())
        .expect("error while running Memstick");
}

fn default_notes_dir() -> Result<PathBuf, String> {
    let app_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "failed to resolve app directory".to_string())?
        .to_path_buf();
    Ok(app_dir.join("notes"))
}

fn workspace_state_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("workspace-state.json"))
        .map_err(|error| error.to_string())
}

fn resolve_note_path(relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }

    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("invalid note path".to_string());
        }
    }

    let path = default_notes_dir()?.join(relative);
    if !is_markdown_file(&path) {
        return Err("only markdown files are allowed".to_string());
    }
    Ok(path)
}

fn scan_directory(root: &Path, dir: &Path, depth: usize) -> Result<Vec<MarkdownTreeNode>, String> {
    if depth > MAX_TREE_DEPTH {
        return Ok(Vec::new());
    }

    let mut folders = Vec::new();
    let mut notes = Vec::new();

    for entry in fs::read_dir(dir).map_err(|error| error.to_string())? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if name.starts_with('.') || file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            let Ok(children) = scan_directory(root, &path, depth + 1) else {
                continue;
            };
            if !children.is_empty() {
                folders.push(MarkdownTreeNode {
                    kind: "folder",
                    name,
                    path: relative_path_string(root, &path)?,
                    children,
                });
            }
        } else if file_type.is_file() && is_markdown_file(&path) {
            notes.push(MarkdownTreeNode {
                kind: "note",
                name,
                path: relative_path_string(root, &path)?,
                children: Vec::new(),
            });
        }
    }

    folders.sort_by_key(|node| node.name.to_lowercase());
    notes.sort_by_key(|node| node.name.to_lowercase());
    folders.extend(notes);
    Ok(folders)
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn open_note_window(app: &AppHandle, spec: NoteWindowSpec) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(spec.label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    open_note_window_at(
        app,
        spec.label,
        spec.title,
        spec.relative_path,
        spec.x,
        spec.y,
        spec.width,
        spec.height,
        spec.opacity,
        true,
    )
}

fn open_note_window_at(
    app: &AppHandle,
    label: &str,
    title: &str,
    relative_path: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    opacity: u8,
    always_on_top: bool,
) -> Result<(), String> {
    let url = format!(
        "note.html#title={}&opacity={}&alwaysOnTop={}&file={}",
        encode_query_component(title),
        opacity,
        always_on_top,
        encode_query_component(relative_path)
    );
    WebviewWindowBuilder::new(app, label, page_url(&url)?)
        .title(title)
        .position(x, y)
        .inner_size(width, height)
        .min_inner_size(320.0, 220.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(always_on_top)
        .transparent(false)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn ensure_note_window_label(label: &str) -> Result<(), String> {
    if DEMO_NOTE_WINDOWS.iter().any(|spec| spec.label == label) || label.starts_with("note-file-") {
        Ok(())
    } else {
        Err(format!("unsupported note window label: {label}"))
    }
}

fn page_url(path: &str) -> Result<WebviewUrl, String> {
    #[cfg(debug_assertions)]
    {
        let url = Url::parse(&format!("http://localhost:1440/{path}"))
            .map_err(|error| error.to_string())?;
        Ok(WebviewUrl::External(url))
    }

    #[cfg(not(debug_assertions))]
    {
        Ok(WebviewUrl::App(path.to_string().into()))
    }
}

fn relative_path_string(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|error| error.to_string())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
}

fn note_window_label(relative_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    relative_path.hash(&mut hasher);
    format!("note-file-{:x}", hasher.finish())
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => {
                let encoded = format!("%{byte:02X}");
                encoded.chars().collect()
            }
        })
        .collect()
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show_main", "Show Memstick", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide_main", "Hide Memstick", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle_main", "Toggle Memstick", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &toggle, &quit])?;

    let mut tray = TrayIconBuilder::with_id("memstick")
        .tooltip("Memstick")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show_main" => show_window(app),
            "hide_main" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            "toggle_main" => toggle_window(app),
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.build(app)?;
    Ok(())
}

fn register_default_shortcut(app: &AppHandle) -> Result<(), tauri_plugin_global_shortcut::Error> {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    app.global_shortcut().register(shortcut)?;
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_window(app),
        }
    }
}

fn shortcut_to_label(shortcut: &Shortcut) -> String {
    format!("{shortcut:?}")
}
