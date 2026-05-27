// Computer-Use PiP — 自主操作（computer-use）进行时，右上角悬浮一个透明穿透小窗，
// 实时显示 agent 正在操作的截图，提升信任 / 透明度。复用 appshots overlay 的窗口范式。
//
// 帧来源是 TS main 的 computer-use 截图（screencapture PNG），经 renderer 读成 dataURL
// 后调 `pip_frame` 推进来；本模块只负责窗口创建 / 更新 / 销毁，不做捕获。
// 用 `eval` 注入帧而非 Tauri event，避免 PiP 窗口依赖 withGlobalTauri。

use std::path::PathBuf;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const PIP_LABEL: &str = "computer-use-pip";
const PIP_WIDTH: f64 = 320.0;
const PIP_HEIGHT: f64 = 220.0;
const PIP_MARGIN: f64 = 16.0;
/// 顶部留白避开菜单栏。
const PIP_TOP_OFFSET: f64 = 28.0;

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

    let _ = window.set_ignore_cursor_events(true);

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
        let _ = w.eval(&format!("window.__setFrame && window.__setFrame({payload})"));
    }
    Ok(())
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
