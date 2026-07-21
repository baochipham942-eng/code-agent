// Computer-Use PiP — 自主操作（computer-use）进行时，右上角悬浮一个透明穿透小窗，
// 实时显示 agent 正在操作的截图，提升信任 / 透明度。复用 appshots overlay 的窗口范式。
//
// 帧来源是 TS main 的 computer-use 截图（screencapture PNG），经 renderer 读成 dataURL
// 后调 `pip_frame` 推进来；本模块只负责窗口创建 / 更新 / 销毁，不做捕获。
// 用 `eval` 注入帧而非 Tauri event，避免 PiP 窗口依赖 withGlobalTauri。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const PIP_LABEL: &str = "computer-use-pip";
const PIP_WIDTH: f64 = 320.0;
const PIP_HEIGHT: f64 = 220.0;
const PIP_MARGIN: f64 = 16.0;
/// 顶部留白避开菜单栏。
const PIP_TOP_OFFSET: f64 = 28.0;
const PIP_CONTROL_EVENT: &str = "surface-pip-control";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipControlScope {
    conversation_id: String,
    run_id: String,
    agent_id: String,
    surface_session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipControlRequestState {
    action: String,
    status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipControlsPayload {
    version: u8,
    scope: PipControlScope,
    surface: String,
    state: String,
    available_controls: Vec<String>,
    control_request: Option<PipControlRequestState>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PipControlPayload {
    version: u8,
    scope: PipControlScope,
    action: String,
}

fn valid_scope(scope: &PipControlScope) -> bool {
    [
        &scope.conversation_id,
        &scope.run_id,
        &scope.agent_id,
        &scope.surface_session_id,
    ]
    .iter()
    .all(|value| !value.trim().is_empty() && value.len() <= 512)
}

fn valid_control(action: &str) -> bool {
    matches!(action, "pause" | "resume" | "takeover" | "stop")
}

fn validate_controls(controls: &PipControlsPayload) -> Result<(), String> {
    if controls.version != 1 || !valid_scope(&controls.scope) {
        return Err("invalid Surface PiP control scope".into());
    }
    if !matches!(controls.surface.as_str(), "browser" | "computer") {
        return Err("invalid Surface PiP surface".into());
    }
    if !matches!(
        controls.state.as_str(),
        "preparing"
            | "waiting_permission"
            | "running"
            | "waiting_human"
            | "paused"
            | "stopping"
            | "completed"
            | "failed"
    ) || controls
        .available_controls
        .iter()
        .any(|action| !valid_control(action))
    {
        return Err("invalid Surface PiP control state".into());
    }
    if let Some(request) = &controls.control_request {
        if !valid_control(&request.action)
            || !matches!(request.status.as_str(), "pending" | "succeeded" | "failed")
        {
            return Err("invalid Surface PiP control request".into());
        }
    }
    Ok(())
}

fn pip_url() -> WebviewUrl {
    WebviewUrl::App(PathBuf::from("pip.html"))
}

/// 主屏工作区右上角坐标（逻辑像素）。
fn pip_top_right(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let size = mon.size();
        let pos = mon.position();
        let origin_x = pos.x as f64 / scale;
        let origin_y = pos.y as f64 / scale;
        let work_w = size.width as f64 / scale;
        let x = origin_x + work_w - PIP_WIDTH - PIP_MARGIN;
        let y = origin_y + PIP_TOP_OFFSET;
        (x, y)
    } else {
        (PIP_MARGIN, PIP_MARGIN)
    }
}

/// 创建并显示 PiP 窗口（幂等：已存在则只 show）。
#[tauri::command]
pub fn pip_show(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(PIP_LABEL) {
        let _ = w.set_ignore_cursor_events(false);
        let _ = w.show();
        return Ok(());
    }
    let url = pip_url();
    let (pos_x, pos_y) = pip_top_right(&app);

    let window = WebviewWindowBuilder::new(&app, PIP_LABEL, url)
        .position(pos_x, pos_y)
        .inner_size(PIP_WIDTH, PIP_HEIGHT)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .shadow(false)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        .closable(false)
        .minimizable(false)
        .visible(true)
        .build()
        .map_err(|e| format!("pip window build: {e}"))?;

    let _ = window.set_ignore_cursor_events(false);

    // 抬到 screen-saver 级 + 可进所有 Space，盖过全屏 app。AppKit 调用必须回主线程。
    #[cfg(target_os = "macos")]
    {
        let app_for_level = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_for_level.get_webview_window(PIP_LABEL) {
                if let Ok(ptr) = w.ns_window() {
                    unsafe { raise_pip_window_level(ptr) };
                }
            }
        });
    }
    Ok(())
}

/// 推一帧截图（dataURL）到 PiP 窗口。窗口不在则静默忽略。
#[tauri::command]
pub fn pip_frame(app: AppHandle, data_url: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(PIP_LABEL) {
        let payload = serde_json::to_string(&data_url).map_err(|e| e.to_string())?;
        let _ = w.eval(&format!(
            "window.__setFrame && window.__setFrame({payload})"
        ));
    }
    Ok(())
}

/// 把当前 Surface scope、实际状态和可用控制投影到 PiP。
#[tauri::command]
pub fn pip_controls(app: AppHandle, controls: PipControlsPayload) -> Result<(), String> {
    validate_controls(&controls)?;
    if let Some(w) = app.get_webview_window(PIP_LABEL) {
        let payload = serde_json::to_string(&controls).map_err(|e| e.to_string())?;
        w.eval(&format!(
            "window.__setControls && window.__setControls({payload})"
        ))
        .map_err(|e| format!("pip controls: {e}"))?;
    }
    Ok(())
}

/// 只接受 PiP webview 发出的 owner-scoped 控制意图，再由主 renderer 复核并执行。
#[tauri::command]
pub fn pip_control(
    app: AppHandle,
    window: WebviewWindow,
    payload: PipControlPayload,
) -> Result<(), String> {
    if window.label() != PIP_LABEL {
        return Err("Surface PiP controls are only accepted from the PiP window".into());
    }
    if payload.version != 1 || !valid_scope(&payload.scope) || !valid_control(&payload.action) {
        return Err("invalid Surface PiP control intent".into());
    }
    app.emit(PIP_CONTROL_EVENT, payload)
        .map_err(|e| format!("pip control event: {e}"))
}

/// 关闭 PiP 窗口。
#[tauri::command]
pub fn pip_hide(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(PIP_LABEL) {
        let _ = w.close();
    }
    Ok(())
}

/// 把 PiP 的 NSWindow 抬到 screen-saver 级并允许进入所有 Space + 全屏 Space。
/// 必须在主线程调用（由 run_on_main_thread 保证）。
#[cfg(target_os = "macos")]
unsafe fn raise_pip_window_level(ns_window_ptr: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
    if ns_window_ptr.is_null() {
        return;
    }
    let window: &NSWindow = &*(ns_window_ptr as *const NSWindow);
    // NSScreenSaverWindowLevel = 1000
    window.setLevel(1000);
    window.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
}
