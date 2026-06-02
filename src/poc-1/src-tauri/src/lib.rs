use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorContext {
    document_path: Option<String>,
    project_root: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedImageAsset {
    markdown_path: String,
    copied: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedImageSource {
    src: String,
}

#[tauri::command]
fn editor_context() -> EditorContext {
    let document_path = default_document_path();
    let project_root = find_project_root(&document_path);

    EditorContext {
        document_path: Some(path_to_string(&document_path)),
        project_root: Some(path_to_string(&project_root)),
    }
}

#[tauri::command(rename_all = "camelCase")]
fn prepare_image_asset(
    source_path: String,
    document_path: Option<String>,
    project_root: Option<String>,
) -> Result<PreparedImageAsset, String> {
    let source = absolute_path(Path::new(&source_path))?;
    ensure_image_path(&source)?;

    let document = saved_document_path(document_path)?;
    let document_dir = document
        .parent()
        .ok_or_else(|| "Document path has no parent directory.".to_string())?;
    let root = project_root
        .map(PathBuf::from)
        .unwrap_or_else(|| find_project_root(&document));
    let canonical_root = absolute_path(&root)?;

    if source.starts_with(&canonical_root) {
        return Ok(PreparedImageAsset {
            markdown_path: relative_markdown_path(&source, document_dir)?,
            copied: false,
        });
    }

    let assets_dir = document_dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("Failed to create assets directory: {error}"))?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_file_name)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "image.png".to_string());
    let target = unique_asset_path(&assets_dir, &file_name);

    fs::copy(&source, &target).map_err(|error| format!("Failed to copy image: {error}"))?;

    Ok(PreparedImageAsset {
        markdown_path: relative_markdown_path(&target, document_dir)?,
        copied: true,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn save_image_asset(
    bytes: Vec<u8>,
    suggested_name: Option<String>,
    document_path: Option<String>,
) -> Result<PreparedImageAsset, String> {
    if bytes.is_empty() {
        return Err("Image data is empty.".to_string());
    }

    let document = saved_document_path(document_path)?;
    let document_dir = document
        .parent()
        .ok_or_else(|| "Document path has no parent directory.".to_string())?;
    let assets_dir = document_dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|error| format!("Failed to create assets directory: {error}"))?;

    let file_name = suggested_name
        .as_deref()
        .map(sanitize_file_name)
        .filter(|name| is_image_path(Path::new(name)))
        .unwrap_or_else(|| "pasted-image.png".to_string());
    let target = unique_asset_path(&assets_dir, &file_name);

    fs::write(&target, bytes).map_err(|error| format!("Failed to save image: {error}"))?;

    Ok(PreparedImageAsset {
        markdown_path: relative_markdown_path(&target, document_dir)?,
        copied: true,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn resolve_markdown_image_src(
    markdown_path: String,
    document_path: Option<String>,
) -> Result<Option<ResolvedImageSource>, String> {
    if is_remote_url(&markdown_path) || markdown_path.starts_with("data:") {
        return Ok(None);
    }

    let document = saved_document_path(document_path)?;
    let document_dir = document
        .parent()
        .ok_or_else(|| "Document path has no parent directory.".to_string())?;
    let image_path = if Path::new(&markdown_path).is_absolute() {
        PathBuf::from(&markdown_path)
    } else {
        document_dir.join(markdown_path.replace('/', std::path::MAIN_SEPARATOR_STR))
    };
    let image_path = absolute_path(&image_path)?;
    ensure_image_path(&image_path)?;

    let bytes = fs::read(&image_path).map_err(|error| format!("Failed to read image: {error}"))?;
    let mime = mime_from_path(&image_path);
    let encoded = general_purpose::STANDARD.encode(bytes);

    Ok(Some(ResolvedImageSource {
        src: format!("data:{mime};base64,{encoded}"),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            editor_context,
            prepare_image_asset,
            save_image_asset,
            resolve_markdown_image_src
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn default_document_path() -> PathBuf {
    app_root().join("docs").join("sample.md")
}

fn saved_document_path(document_path: Option<String>) -> Result<PathBuf, String> {
    document_path
        .map(PathBuf::from)
        .ok_or_else(|| "Save the document before inserting local images.".to_string())
}

fn app_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
}

fn find_project_root(start: &Path) -> PathBuf {
    let start_dir = if start.is_dir() {
        start
    } else {
        start.parent().unwrap_or(start)
    };

    start_dir
        .ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .map(Path::to_path_buf)
        .unwrap_or_else(app_root)
}

fn absolute_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return fs::canonicalize(path)
            .map_err(|error| format!("Failed to resolve path {}: {error}", path.display()));
    }

    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        std::env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| format!("Failed to resolve current directory: {error}"))
    }
}

fn relative_markdown_path(target: &Path, from_dir: &Path) -> Result<String, String> {
    let base = absolute_path(from_dir)?;
    let target = absolute_path(target)?;
    let relative = pathdiff::diff_paths(target, base)
        .ok_or_else(|| "Failed to calculate relative image path.".to_string())?;
    Ok(path_to_markdown(&relative))
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn path_to_markdown(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn unique_asset_path(directory: &Path, file_name: &str) -> PathBuf {
    let source_name = Path::new(file_name);
    let stem = source_name
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = source_name
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("png");

    let mut candidate = directory.join(format!("{stem}.{extension}"));
    let mut suffix = 2;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{suffix}.{extension}"));
        suffix += 1;
    }

    candidate
}

fn ensure_image_path(path: &Path) -> Result<(), String> {
    if is_image_path(path) {
        Ok(())
    } else {
        Err(format!("Unsupported image type: {}", path.display()))
    }
}

fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
            )
        })
        .unwrap_or(false)
}

fn is_remote_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    }
}
