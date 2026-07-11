#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_bridge;

use desktop_bridge::{
    ensure_data_dir, ensure_env_template, load_or_create_bridge_token, start_bridge, BridgeConfig,
};
use serde::Serialize;
use std::{collections::HashMap, fs, path::Path, sync::Mutex};
use tauri::{Manager, RunEvent, WindowEvent};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct BackendProcess(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    backend_url: String,
    bridge_url: String,
    data_dir: String,
    config_file: String,
    backend_running: bool,
}

fn read_env_file(path: &Path) -> HashMap<String, String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            Some((key.to_string(), value))
        })
        .collect()
}

#[tauri::command]
fn get_desktop_runtime_info(app: tauri::AppHandle) -> Result<RuntimeInfo, String> {
    let data_dir = ensure_data_dir()?;
    let backend_running = app
        .try_state::<BackendProcess>()
        .and_then(|state| state.0.lock().ok().map(|guard| guard.is_some()))
        .unwrap_or(false);

    Ok(RuntimeInfo {
        backend_url: "http://127.0.0.1:8787".to_string(),
        bridge_url: "http://127.0.0.1:8765".to_string(),
        config_file: data_dir.join(".env").display().to_string(),
        data_dir: data_dir.display().to_string(),
        backend_running,
    })
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn start_backend(app: &tauri::AppHandle, token: &str, data_dir: &Path) -> Result<CommandChild, String> {
    let env_file = data_dir.join(".env");
    let mut command = app
        .shell()
        .sidecar("cherry-backend")
        .map_err(|error| format!("Failed to resolve Cherry backend sidecar: {error}"))?;

    for (key, value) in read_env_file(&env_file) {
        command = command.env(key, value);
    }

    command = command
        .env("CHERRY_HOST", "127.0.0.1")
        .env("CHERRY_PORT", "8787")
        .env("CHERRY_DESKTOP_ENABLED", "true")
        .env("CHERRY_DESKTOP_BRIDGE_URL", "http://127.0.0.1:8765")
        .env("CHERRY_DESKTOP_BRIDGE_TOKEN", token)
        .env("CHERRY_MEMORY_FILE", data_dir.join("memory.json").display().to_string())
        .env("CHERRY_PLANNER_FILE", data_dir.join("planner.json").display().to_string())
        .env("CHERRY_ENGINEER_FILE", data_dir.join("engineer.json").display().to_string())
        .env("CHERRY_AGENTIC_FILE", data_dir.join("agentic.json").display().to_string())
        .env("CHERRY_WORKSPACE", data_dir.join("workspace").display().to_string());

    let (mut rx, child) = command
        .spawn()
        .map_err(|error| format!("Failed to start Cherry backend sidecar: {error}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                tauri_plugin_shell::process::CommandEvent::Stdout(bytes) => {
                    println!("[cherry-backend] {}", String::from_utf8_lossy(&bytes));
                }
                tauri_plugin_shell::process::CommandEvent::Stderr(bytes) => {
                    eprintln!("[cherry-backend] {}", String::from_utf8_lossy(&bytes));
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_desktop_runtime_info, quit_app])
        .setup(|app| {
            let data_dir = ensure_data_dir().map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            ensure_env_template(&data_dir).map_err(|error| Box::<dyn std::error::Error>::from(error))?;
            let token = load_or_create_bridge_token(&data_dir)
                .map_err(|error| Box::<dyn std::error::Error>::from(error))?;

            start_bridge(BridgeConfig {
                bind: "127.0.0.1:8765".to_string(),
                token: token.clone(),
            })
            .map_err(|error| Box::<dyn std::error::Error>::from(error))?;

            let child = match start_backend(app.handle(), &token, &data_dir) {
                Ok(child) => Some(child),
                Err(error) => {
                    eprintln!("{error}");
                    None
                }
            };
            app.manage(BackendProcess(Mutex::new(child)));

            let mut tray = TrayIconBuilder::new().tooltip("CherryAgent — Windows AI Assistant");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    if let Some(window) = tray.app_handle().get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            })
            .build(app)?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CherryAgent desktop application");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.hide();
            }
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<BackendProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
        _ => {}
    });
}
