use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use enigo::{
    Button, Coordinate,
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Mouse, Settings,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;
use xcap::{Monitor, Window};

const BRIDGE_VERSION: &str = "0.1.0";

#[derive(Clone)]
pub struct BridgeConfig {
    pub bind: String,
    pub token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    index: usize,
    name: String,
    is_primary: bool,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    title: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    minimized: bool,
    maximized: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    monitor_index: Option<usize>,
}

#[derive(Deserialize)]
struct MoveMouseRequest {
    x: i32,
    y: i32,
    relative: Option<bool>,
}

#[derive(Deserialize)]
struct ClickRequest {
    button: Option<String>,
    clicks: Option<u8>,
}

#[derive(Deserialize)]
struct TypeTextRequest {
    text: String,
}

#[derive(Deserialize)]
struct PressKeyRequest {
    key: String,
    modifiers: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct SpeakRequest {
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenRequest {
    timeout_ms: Option<u64>,
}

pub fn ensure_data_dir() -> Result<PathBuf, String> {
    let root = dirs::data_local_dir().ok_or("Unable to resolve local application data directory")?;
    let dir = root.join("CherryAgent");
    fs::create_dir_all(&dir).map_err(|error| format!("Failed to create app data directory: {error}"))?;
    Ok(dir)
}

pub fn load_or_create_bridge_token(data_dir: &Path) -> Result<String, String> {
    if let Ok(value) = std::env::var("CHERRY_DESKTOP_BRIDGE_TOKEN") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let token_path = data_dir.join("desktop-bridge.token");
    if let Ok(value) = fs::read_to_string(&token_path) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let token = Uuid::new_v4().to_string();
    fs::write(&token_path, format!("{token}\n"))
        .map_err(|error| format!("Failed to write desktop bridge token: {error}"))?;
    Ok(token)
}

pub fn ensure_env_template(data_dir: &Path) -> Result<(), String> {
    let path = data_dir.join(".env");
    if path.exists() {
        return Ok(());
    }

    let template = r#"# CherryAgent Windows local runtime
CHERRY_HOST=127.0.0.1
CHERRY_PORT=8787
CHERRY_DESKTOP_ENABLED=true
CHERRY_DESKTOP_BRIDGE_URL=http://127.0.0.1:8765

# Point these at your local or hosted OpenAI-compatible model endpoint.
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b

# CherryAgent API authentication (required before the backend starts)
CHERRY_AUTH_ADMIN_EMAIL=padd@cherrydeskx.com
# Set CHERRY_AUTH_ADMIN_PASSWORD to a unique value with at least 12 characters.

# Optional multimodal model. Defaults to the main LLM settings.
CHERRY_VISION_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_VISION_API_KEY=local
CHERRY_VISION_MODEL=qwen3.6-27b

# Safe and local state operations are auto-approved. Desktop observation/input remains approval-gated.
CHERRY_AUTO_APPROVE=safe,write
"#;

    fs::write(path, template).map_err(|error| format!("Failed to create .env template: {error}"))
}

pub fn start_bridge(config: BridgeConfig) -> Result<(), String> {
    let server = Server::http(&config.bind)
        .map_err(|error| format!("Failed to bind desktop bridge {}: {error}", config.bind))?;

    thread::Builder::new()
        .name("cherry-desktop-bridge".to_string())
        .spawn(move || {
            for request in server.incoming_requests() {
                handle_request(request, &config.token);
            }
        })
        .map_err(|error| format!("Failed to start desktop bridge thread: {error}"))?;

    Ok(())
}

fn handle_request(mut request: Request, token: &str) {
    if !authorized(&request, token) {
        respond(request, 401, json!({ "ok": false, "error": "Unauthorized" }));
        return;
    }

    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or(request.url()).to_string();

    let result = match (method, path.as_str()) {
        (Method::Get, "/health") => Ok(json!({
            "ok": true,
            "platform": "windows",
            "bridgeVersion": BRIDGE_VERSION,
            "automationEnabled": true,
            "visionEnabled": true,
            "speechEnabled": true
        })),
        (Method::Get, "/v1/monitors") => list_monitors().map(|monitors| json!({ "monitors": monitors })),
        (Method::Get, "/v1/windows") => list_windows().map(|windows| json!({ "windows": windows })),
        (Method::Post, "/v1/screen/capture") => parse_json::<CaptureRequest>(&mut request).and_then(capture_screen),
        (Method::Post, "/v1/mouse/move") => parse_json::<MoveMouseRequest>(&mut request).and_then(move_mouse),
        (Method::Post, "/v1/mouse/click") => parse_json::<ClickRequest>(&mut request).and_then(click_mouse),
        (Method::Post, "/v1/keyboard/type") => parse_json::<TypeTextRequest>(&mut request).and_then(type_text),
        (Method::Post, "/v1/keyboard/key") => parse_json::<PressKeyRequest>(&mut request).and_then(press_key),
        (Method::Post, "/v1/speech/speak") => parse_json::<SpeakRequest>(&mut request).and_then(speak),
        (Method::Post, "/v1/speech/listen") => parse_json::<ListenRequest>(&mut request).and_then(listen),
        _ => Err(format!("Unknown route: {} {}", request.method(), path)),
    };

    match result {
        Ok(value) => respond(request, 200, value),
        Err(error) => respond(request, 400, json!({ "ok": false, "error": error })),
    }
}

fn authorized(request: &Request, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .map(|header| header.value.as_str() == expected)
        .unwrap_or(false)
}

fn parse_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| format!("Failed to read request body: {error}"))?;
    serde_json::from_str(&body).map_err(|error| format!("Invalid JSON body: {error}"))
}

fn respond(request: Request, status: u16, value: Value) {
    let content_type = Header::from_bytes(&b"content-type"[..], &b"application/json; charset=utf-8"[..])
        .expect("valid static content-type header");
    let response = Response::from_string(value.to_string())
        .with_status_code(StatusCode(status))
        .with_header(content_type);
    let _ = request.respond(response);
}

fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|error| format!("Failed to enumerate monitors: {error}"))?;
    monitors
        .into_iter()
        .enumerate()
        .map(|(index, monitor)| {
            Ok(MonitorInfo {
                index,
                name: format!("Monitor {index}"),
                is_primary: monitor.is_primary().unwrap_or(false),
                width: monitor.width().map_err(|error| error.to_string())?,
                height: monitor.height().map_err(|error| error.to_string())?,
                x: monitor.x().map_err(|error| error.to_string())?,
                y: monitor.y().map_err(|error| error.to_string())?,
            })
        })
        .collect()
}

fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|error| format!("Failed to enumerate windows: {error}"))?;
    let mut output = Vec::new();
    for window in windows {
        let title = window.title().unwrap_or_default();
        if title.trim().is_empty() {
            continue;
        }
        output.push(WindowInfo {
            title,
            x: window.x().unwrap_or_default(),
            y: window.y().unwrap_or_default(),
            width: window.width().unwrap_or_default(),
            height: window.height().unwrap_or_default(),
            minimized: window.is_minimized().unwrap_or(false),
            maximized: window.is_maximized().unwrap_or(false),
        });
        if output.len() >= 200 {
            break;
        }
    }
    Ok(output)
}

fn capture_screen(input: CaptureRequest) -> Result<Value, String> {
    let index = input.monitor_index.unwrap_or(0);
    let monitors = Monitor::all().map_err(|error| format!("Failed to enumerate monitors: {error}"))?;
    let monitor = monitors
        .into_iter()
        .nth(index)
        .ok_or_else(|| format!("Monitor index {index} does not exist"))?;
    let image = monitor.capture_image().map_err(|error| format!("Screen capture failed: {error}"))?;
    let width = image.width();
    let height = image.height();

    let temp = std::env::temp_dir().join(format!("cherry-screen-{}.png", Uuid::new_v4()));
    image.save(&temp).map_err(|error| format!("Failed to encode screenshot: {error}"))?;
    let bytes = fs::read(&temp).map_err(|error| format!("Failed to read screenshot bytes: {error}"))?;
    let _ = fs::remove_file(&temp);

    Ok(json!({
        "mimeType": "image/png",
        "imageBase64": BASE64.encode(bytes),
        "width": width,
        "height": height,
        "monitorIndex": index,
        "capturedAt": Utc::now().to_rfc3339()
    }))
}

fn new_enigo() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|error| format!("Failed to initialize input automation: {error}"))
}

fn move_mouse(input: MoveMouseRequest) -> Result<Value, String> {
    let mut enigo = new_enigo()?;
    let coordinate = if input.relative.unwrap_or(false) { Coordinate::Rel } else { Coordinate::Abs };
    enigo
        .move_mouse(input.x, input.y, coordinate)
        .map_err(|error| format!("Mouse move failed: {error}"))?;
    Ok(json!({ "ok": true, "x": input.x, "y": input.y, "relative": input.relative.unwrap_or(false) }))
}

fn click_mouse(input: ClickRequest) -> Result<Value, String> {
    let button_name = input.button.unwrap_or_else(|| "left".to_string()).to_lowercase();
    let button = match button_name.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return Err("button must be left, right, or middle".to_string()),
    };
    let clicks = input.clicks.unwrap_or(1);
    if !(1..=3).contains(&clicks) {
        return Err("clicks must be between 1 and 3".to_string());
    }
    let mut enigo = new_enigo()?;
    for index in 0..clicks {
        enigo.button(button, Click).map_err(|error| format!("Mouse click failed: {error}"))?;
        if index + 1 < clicks {
            thread::sleep(Duration::from_millis(100));
        }
    }
    Ok(json!({ "ok": true, "button": button_name, "clicks": clicks }))
}

fn type_text(input: TypeTextRequest) -> Result<Value, String> {
    if input.text.len() > 20_000 {
        return Err("Text exceeds 20000-byte limit".to_string());
    }
    let mut enigo = new_enigo()?;
    enigo.text(&input.text).map_err(|error| format!("Typing failed: {error}"))?;
    Ok(json!({ "ok": true, "characters": input.text.chars().count() }))
}

fn named_key(name: &str) -> Option<Key> {
    match name.to_lowercase().as_str() {
        "enter" | "return" => Some(Key::Return),
        "tab" => Some(Key::Tab),
        "escape" | "esc" => Some(Key::Escape),
        "backspace" => Some(Key::Backspace),
        "delete" | "del" => Some(Key::Delete),
        "space" => Some(Key::Space),
        "up" => Some(Key::UpArrow),
        "down" => Some(Key::DownArrow),
        "left" => Some(Key::LeftArrow),
        "right" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" => Some(Key::PageUp),
        "pagedown" => Some(Key::PageDown),
        "insert" => Some(Key::Insert),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        _ => {
            let mut chars = name.chars();
            let first = chars.next()?;
            if chars.next().is_none() { Some(Key::Unicode(first)) } else { None }
        }
    }
}

fn modifier_key(name: &str) -> Option<Key> {
    match name.to_lowercase().as_str() {
        "control" | "ctrl" => Some(Key::Control),
        "alt" => Some(Key::Alt),
        "shift" => Some(Key::Shift),
        "meta" | "windows" | "win" | "super" => Some(Key::Meta),
        _ => None,
    }
}

fn press_key(input: PressKeyRequest) -> Result<Value, String> {
    let key = named_key(&input.key).ok_or_else(|| format!("Unsupported key: {}", input.key))?;
    let modifiers = input.modifiers.unwrap_or_default();
    let mut modifier_keys = Vec::new();
    for name in &modifiers {
        modifier_keys.push(modifier_key(name).ok_or_else(|| format!("Unsupported modifier: {name}"))?);
    }

    let mut enigo = new_enigo()?;
    for modifier in &modifier_keys {
        enigo.key(*modifier, Press).map_err(|error| format!("Modifier press failed: {error}"))?;
    }
    let key_result = enigo.key(key, Click).map_err(|error| format!("Key press failed: {error}"));
    for modifier in modifier_keys.iter().rev() {
        let _ = enigo.key(*modifier, Release);
    }
    key_result?;

    Ok(json!({ "ok": true, "key": input.key, "modifiers": modifiers }))
}

fn speak(input: SpeakRequest) -> Result<Value, String> {
    if input.text.trim().is_empty() {
        return Err("text is required".to_string());
    }
    if input.text.len() > 10_000 {
        return Err("Speech text exceeds 10000-byte limit".to_string());
    }

    let script = r#"Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.Speak($env:CHERRY_SPEECH_TEXT)"#;
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CHERRY_SPEECH_TEXT", &input.text)
        .status()
        .map_err(|error| format!("Failed to start Windows speech synthesizer: {error}"))?;
    if !status.success() {
        return Err(format!("Windows speech synthesizer exited with status {status}"));
    }
    Ok(json!({ "ok": true, "characters": input.text.chars().count() }))
}

fn listen(input: ListenRequest) -> Result<Value, String> {
    let timeout_ms = input.timeout_ms.unwrap_or(10_000).clamp(1_000, 30_000);
    let timeout_seconds = (timeout_ms as f64 / 1000.0).ceil() as u64;
    let script = format!(
        "Add-Type -AssemblyName System.Speech; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::UTF8; $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine; $r.SetInputToDefaultAudioDevice(); $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $result = $r.Recognize([TimeSpan]::FromSeconds({timeout_seconds})); if ($result) {{ Write-Output $result.Text }}"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("Failed to start Windows speech recognition: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Windows speech recognition failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(json!({ "text": text, "timeoutMs": timeout_ms }))
}
