# CherryAgent Windows Desktop Agent

> Status: **Implemented MVP, pending/subject to CI validation for each change.**
>
> This module packages CherryAgent as an installable Windows desktop assistant with a Tauri 2 shell, a bundled local Cherry backend sidecar, a loopback-only native desktop bridge, approval-gated mouse/keyboard/screen/microphone tools, multimodal vision, speech synthesis, and speech recognition.

---

# 1. Goals

The Windows Desktop Agent should let a user install CherryAgent on a PC and ask it to:

- run in a desktop window and system tray,
- start its local CherryAgent backend automatically,
- move the mouse,
- click mouse buttons,
- type Unicode text,
- press named keys and modifier combinations,
- enumerate monitors,
- inspect visible window titles and geometry,
- capture the screen,
- send a screenshot to a configured multimodal model,
- speak through Windows text-to-speech,
- listen once through the default microphone using Windows speech recognition,
- execute multi-step work through the existing Agentic Core,
- use the existing Approval Inbox before privacy-sensitive or consequential desktop actions,
- keep desktop automation evidence inside the normal Cherry tool trace and Correctness Loop.

The desktop agent is not a separate fake chatbot. It extends the existing CherryAgent tool runtime.

---

# 2. End-to-End Architecture

```text
User
  |
  v
CherryAgent Windows Desktop UI
  |  POST /chat
  v
Local Cherry Backend Sidecar
127.0.0.1:8787
  |
  +--> Agentic Core
  +--> Multi-Agent Orchestrator
  +--> Engineer Loop
  +--> Correctness Loop
  +--> Approval Gate
  +--> Desktop Tool Pack
             |
             v
     Authenticated Native Bridge
        127.0.0.1:8765
             |
    +--------+---------+---------+---------+
    |                  |         |         |
    v                  v         v         v
 Mouse/Keyboard     Screen     Speech    Windows
    Enigo            XCap      System.   Desktop
                                Speech
             |
             v
         Real PC state
```

For visual reasoning:

```text
Desktop screen
   |
   v
XCap screenshot
   |
   v
PNG in memory/base64 transport
   |
   v
OpenAI-compatible multimodal endpoint
   |
   v
Visible-state description
   |
   v
Cherry planning / next action
   |
   v
Approval Gate
   |
   v
Mouse / keyboard action
   |
   v
Capture again and verify
```

---

# 3. Main Components

## 3.1 Tauri Desktop Shell

Files:

```text
src-tauri/Cargo.toml
src-tauri/build.rs
src-tauri/tauri.conf.json
src-tauri/capabilities/default.json
src-tauri/src/main.rs
src-tauri/src/desktop_bridge.rs
```

Responsibilities:

- open the Windows desktop window,
- run in the tray,
- hide the main window instead of terminating on normal close,
- initialize the native bridge,
- generate/load the desktop bridge token,
- create the first-run `.env` template,
- launch the compiled Cherry backend sidecar,
- stop the sidecar on application exit.

---

## 3.2 Bundled Cherry Backend Sidecar

The existing TypeScript backend is built first:

```bash
npm run build
```

Then the compiled entry is converted into a Windows executable in CI:

```text
src-tauri/binaries/cherry-backend-x86_64-pc-windows-msvc.exe
```

Tauri bundles it as an external binary sidecar.

At startup, the desktop app injects runtime values including:

```text
CHERRY_HOST=127.0.0.1
CHERRY_PORT=8787
CHERRY_DESKTOP_ENABLED=true
CHERRY_DESKTOP_BRIDGE_URL=http://127.0.0.1:8765
CHERRY_DESKTOP_BRIDGE_TOKEN=<generated local token>
```

Persistent state is redirected to the local CherryAgent app-data directory:

```text
memory.json
planner.json
engineer.json
agentic.json
workspace/
.env
```

On typical Windows installations the directory resolves under local application data:

```text
%LOCALAPPDATA%\CherryAgent\
```

---

# 4. Native Desktop Bridge

The bridge binds only to:

```text
127.0.0.1:8765
```

It is not intended to listen on LAN or public interfaces.

Authentication:

```http
Authorization: Bearer <local bridge token>
```

Token discovery order:

1. `CHERRY_DESKTOP_BRIDGE_TOKEN` environment variable.
2. Existing local token file.
3. Generate a new UUID token and persist it.

Token file:

```text
%LOCALAPPDATA%\CherryAgent\desktop-bridge.token
```

The TypeScript `WindowsDesktopClient` uses the configured token or discovers the same local token file.

---

# 5. Bridge HTTP API

## 5.1 Health

```http
GET /health
```

Returns:

```json
{
  "ok": true,
  "platform": "windows",
  "bridgeVersion": "0.1.0",
  "automationEnabled": true,
  "visionEnabled": true,
  "speechEnabled": true
}
```

## 5.2 Monitors

```http
GET /v1/monitors
```

Returns monitor index, name, primary state and geometry.

## 5.3 Windows

```http
GET /v1/windows
```

Returns visible non-empty window titles and geometry, capped to avoid unbounded output.

## 5.4 Screen Capture

```http
POST /v1/screen/capture
content-type: application/json

{
  "monitorIndex": 0
}
```

Returns PNG metadata and base64 pixels to the trusted local TypeScript connector. Raw pixels are not returned by the normal `desktop_capture_screen` tool response.

## 5.5 Mouse Move

```http
POST /v1/mouse/move

{
  "x": 500,
  "y": 300,
  "relative": false
}
```

## 5.6 Mouse Click

```http
POST /v1/mouse/click

{
  "button": "left",
  "clicks": 1
}
```

Supported buttons:

```text
left
right
middle
```

Clicks are bounded to 1-3 per request.

## 5.7 Type Text

```http
POST /v1/keyboard/type

{
  "text": "สวัสดีจาก Cherry"
}
```

## 5.8 Press Key

```http
POST /v1/keyboard/key

{
  "key": "s",
  "modifiers": ["control"]
}
```

Supported modifier aliases:

```text
control / ctrl
alt
shift
meta / windows / win / super
```

Common named keys:

```text
enter
return
tab
escape
backspace
delete
space
up
down
left
right
home
end
pageup
pagedown
insert
f1-f12
```

A single Unicode character may also be used as a key.

## 5.9 Speak

```http
POST /v1/speech/speak

{
  "text": "Cherry พร้อมช่วยงานแล้ว"
}
```

Current MVP uses Windows `System.Speech.Synthesis.SpeechSynthesizer` through a non-interactive PowerShell child process.

## 5.10 Listen Once

```http
POST /v1/speech/listen

{
  "timeoutMs": 10000
}
```

Current MVP uses Windows `System.Speech.Recognition.SpeechRecognitionEngine` with the default microphone and dictation grammar.

Limitations:

- depends on Windows speech components and installed language support,
- one-shot recognition only,
- not a low-latency streaming voice-to-voice pipeline,
- microphone quality and language packs affect results.

---

# 6. Cherry Desktop Tool Pack

Files:

```text
src/connectors/desktop/WindowsDesktopClient.ts
src/connectors/desktop/DesktopVisionClient.ts
src/tools/builtin/desktop.ts
src/desktopRuntime.ts
```

Tools:

```text
desktop_get_status
desktop_list_monitors
desktop_list_windows
desktop_capture_screen
desktop_vision_analyze
desktop_move_mouse
desktop_click
desktop_type_text
desktop_press_key
desktop_speak
desktop_listen
```

---

# 7. Risk Policy

Recommended default remains:

```env
CHERRY_AUTO_APPROVE=safe,write
```

Tool risk classification:

| Tool | Risk | Reason |
|---|---|---|
| `desktop_get_status` | safe | connectivity/readiness only |
| `desktop_list_monitors` | safe | geometry only |
| `desktop_list_windows` | external | window titles may expose private context |
| `desktop_capture_screen` | external | screen pixels may contain sensitive data |
| `desktop_vision_analyze` | external | captures and sends screen content to configured vision endpoint |
| `desktop_move_mouse` | external | changes live desktop state |
| `desktop_click` | external | may submit, buy, delete, send or trigger destructive UI |
| `desktop_type_text` | external | writes into the focused application |
| `desktop_press_key` | external | can trigger shortcuts and external actions |
| `desktop_speak` | write | local audible output |
| `desktop_listen` | external | privacy-sensitive microphone access |

A generic desktop click is not automatically considered proof of success.

Correct pattern:

```text
Observe
  -> identify target
  -> request approval
  -> execute click/type/key
  -> observe again
  -> verify actual resulting state
  -> only then claim success
```

---

# 8. Vision Safety and Correctness

`desktop_vision_analyze`:

1. captures the selected monitor,
2. sends the image to the configured multimodal OpenAI-compatible endpoint,
3. asks the model to describe only visibly supported state,
4. returns text analysis to Cherry,
5. does not treat hidden UI state or guessed coordinates as verified facts.

Vision configuration:

```env
CHERRY_VISION_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_VISION_API_KEY=local
CHERRY_VISION_MODEL=qwen3.6-27b
CHERRY_VISION_TIMEOUT_MS=60000
```

The configured model must actually support image input. Pointing `CHERRY_VISION_MODEL` at a text-only model will fail.

For consequential automation, prefer:

```text
Capture
  -> Vision analysis
  -> Action plan
  -> Approval
  -> Mouse/keyboard action
  -> Capture again
  -> Vision verification
  -> Correctness Loop
```

---

# 9. Desktop UI

Files:

```text
desktop-ui/index.html
desktop-ui/app.js
desktop-ui/styles.css
```

Surfaces:

- backend status,
- bridge status,
- pending approval count,
- config path,
- Ask Cherry chat,
- quick vision request,
- quick listen request,
- quick speech request,
- Approval Inbox with approve/deny actions.

The UI talks to the bundled local backend at:

```text
http://127.0.0.1:8787
```

---

# 10. First-Run Configuration

The app creates:

```text
%LOCALAPPDATA%\CherryAgent\.env
```

Minimum useful configuration:

```env
CHERRY_LLM_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_LLM_API_KEY=local
CHERRY_LLM_MODEL=qwen3.6-27b
```

For vision:

```env
CHERRY_VISION_BASE_URL=http://127.0.0.1:8000/v1
CHERRY_VISION_API_KEY=local
CHERRY_VISION_MODEL=<multimodal-model-id>
```

A repository example is also provided:

```text
.env.desktop.example
```

---

# 11. Windows Build Pipeline

Workflow:

```text
.github/workflows/windows-desktop.yml
```

Pipeline:

```text
Checkout
  -> Node 22
  -> npm install
  -> TypeScript typecheck
  -> TypeScript build
  -> Bun setup
  -> compile dist/server.js into cherry-backend.exe sidecar
  -> Rust toolchain
  -> cargo check
  -> Tauri build
  -> upload MSI and NSIS setup artifacts
```

Expected sidecar filename:

```text
src-tauri/binaries/cherry-backend-x86_64-pc-windows-msvc.exe
```

Expected installer outputs:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/*.msi
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe
```

---

# 12. Local Build

Requirements:

- Windows,
- Node.js 22,
- Rust stable MSVC toolchain,
- Tauri Windows prerequisites,
- Bun when compiling the backend sidecar the same way as CI.

Build backend:

```powershell
npm install
npm run typecheck
npm run build
```

Compile sidecar:

```powershell
New-Item -ItemType Directory -Force -Path src-tauri/binaries
bun build dist/server.js --compile --outfile src-tauri/binaries/cherry-backend-x86_64-pc-windows-msvc.exe
```

Build installers:

```powershell
npm run desktop:build -- --target x86_64-pc-windows-msvc
```

---

# 13. Example Agentic Desktop Tasks

## 13.1 Inspect an Error

```text
Goal:
Look at my screen, identify the visible error, explain likely causes, and do not click anything yet.
```

Expected flow:

```text
desktop_vision_analyze
  -> evidence
  -> explanation
```

## 13.2 Repair Through UI

```text
Goal:
Look at the visible application error, determine the safest fix, request approval before mouse or keyboard actions, apply the fix, then verify the visible result.
```

Expected flow:

```text
Engineer Loop
  -> desktop_vision_analyze
  -> diagnose
  -> action plan
  -> approval
  -> desktop_move_mouse / click / type / key
  -> desktop_vision_analyze
  -> verify
  -> learn/runbook
  -> Correctness Loop
```

## 13.3 Voice Assistant

```text
Goal:
Listen to one voice instruction, execute safe read-only work, ask approval before desktop control, then speak the final result aloud.
```

Possible flow:

```text
desktop_listen
  -> user goal
  -> Cherry Agentic Core
  -> tools
  -> approval if required
  -> verify
  -> desktop_speak
```

---

# 14. Current Limitations

- The current speech recognition is one-shot Windows `System.Speech`, not continuous streaming STT.
- The current speech synthesis is Windows `System.Speech`, not neural voice cloning.
- Vision quality depends on the configured multimodal model.
- Generic coordinate-based clicking is less robust than semantic accessibility/UI Automation targeting.
- The native bridge currently exposes low-level automation primitives; a future Windows UI Automation layer should add semantic controls, automation IDs, control types and element trees.
- The bundled local HTTP backend still needs stronger production authentication before exposing anything beyond loopback.
- Desktop automation cannot bypass Windows secure desktop/UAC boundaries.
- Screen capture, microphone and window metadata may contain sensitive data and must remain policy-controlled.

---

# 15. Recommended Next Desktop Layers

Priority order:

1. Windows UI Automation semantic element tree.
2. Active-window capture and region capture tools.
3. OCR bounding boxes and visual grounding coordinates.
4. Robust observe-act-observe computer-use loop with bounded retries.
5. Streaming STT with wake word and voice activity detection.
6. Neural TTS provider integration.
7. Global hotkey to summon Cherry.
8. Autostart plugin.
9. Signed Windows release artifacts.
10. Auto-updater with signed update manifests.
11. Per-application allowlists/denylists.
12. Sensitive-field masking before vision upload.
13. Local-only vision mode.
14. Remote-worker mode with mutually authenticated encrypted transport.

---

# 16. Definition of Done for Desktop MVP

The Windows Desktop MVP is considered technically complete only when:

- TypeScript typecheck passes,
- TypeScript build passes,
- Rust `cargo check` passes on Windows target,
- Tauri build succeeds,
- MSI artifact exists,
- NSIS setup artifact exists,
- app launches,
- local backend starts,
- bridge health succeeds,
- `desktop_get_status` succeeds,
- monitor enumeration succeeds,
- mouse move succeeds after approval,
- click succeeds after approval,
- Unicode typing succeeds after approval,
- screenshot capture succeeds after approval,
- vision analysis succeeds with an actual multimodal model,
- speak succeeds,
- listen succeeds on a machine with supported Windows speech components,
- actions are auditable in agent trace,
- no consequential action is claimed successful without post-action evidence.
