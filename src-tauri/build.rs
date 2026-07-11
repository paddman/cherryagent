use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::{fs, path::Path};

fn ensure_windows_icon() {
    let icon_path = Path::new("icons/icon.ico");
    if icon_path.exists() {
        return;
    }

    let encoded = include_str!("icons/icon.ico.b64").trim();
    let bytes = BASE64.decode(encoded).expect("valid embedded icon base64");
    if let Some(parent) = icon_path.parent() {
        fs::create_dir_all(parent).expect("create icon directory");
    }
    fs::write(icon_path, bytes).expect("write generated Windows icon");
}

fn main() {
    ensure_windows_icon();
    tauri_build::build()
}
