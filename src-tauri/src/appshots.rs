// Appshots — 按全局热键抓取「当前前台 app 窗口」并打包成多模态上下文（截图 + 文本）送进 composer。
//
// Phase 1（本文件）：原生核心链路
//   热键 → 定位前台窗口（排除 Agent Neo 自身）→ `screencapture -l` 截窗
//        → AX 无障碍树取文本 →（AX 为空时）macOS Vision 框架本地 OCR 回填
//        → emit `appshots:capture_ready`
//
// 设计说明：原生能力全部走 `/usr/bin/swift -e` 内联脚本（与 native_desktop.rs 的
// frontmost_document_path 同模式），避免在 Rust 里手写 CoreGraphics/Vision 的 CF FFI。
// 截图复用系统 `screencapture` CLI（`-l <windowId>` 窗口级捕获），不走已弃用的
// CGWindowListCreateImage。

#[cfg(target_os = "macos")]
use crate::native_desktop::run_command_with_timeout;
use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::{
    atomic::{AtomicBool, AtomicPtr, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 默认 Appshots 热键：同时按下左右 Command。
pub const DEFAULT_APPSHOTS_SHORTCUT: &str = "LeftCmd+RightCmd";

#[cfg(target_os = "macos")]
const OWN_BUNDLE_ID: &str = "com.linchen.code-agent";
#[cfg(target_os = "macos")]
const AX_TEXT_MAX_CHARS: usize = 4000;
#[cfg(target_os = "macos")]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const SWIFT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppshotsCaptureInfo {
    pub request_id: String,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub screenshot_path: String,
    /// 窗口可读文本：优先 AX 无障碍树，AX 为空时回退本地 OCR。
    pub ax_text: Option<String>,
    /// 文本来源："ax" | "ocr" | "none"，便于前端在 chip 上提示。
    pub text_source: String,
    /// 窗口在屏幕上的位置（CoreGraphics 坐标，左上原点），供 Phase 3 飞入动画用。
    pub window_frame: ScreenRect,
    pub captured_at_ms: u128,
}

/// `#[tauri::command]`：手动触发一次 appshot（与热键共用同一条捕获链路）。
/// 捕获在独立线程进行，命令立即返回，结果通过事件回送。
#[tauri::command]
pub fn appshots_trigger(app: AppHandle) -> Result<(), String> {
    trigger_capture(app);
    Ok(())
}

/// 供全局热键回调调用：在后台线程跑捕获，避免阻塞热键线程。
pub fn trigger_capture(app: AppHandle) {
    std::thread::spawn(move || {
        capture_now(&app);
    });
}

/// 注册 Appshots 的左右 Command 全局热键。
///
/// Tauri/global-hotkey 只能表达「修饰键 + 普通按键」，不能区分左右 Command，也不能注册
/// 纯修饰键组合。这里用 macOS listen-only event tap 监听物理左右 Command 键状态，命中后
/// 仍然复用同一条 `trigger_capture` 链路。
#[cfg(target_os = "macos")]
pub fn setup_dual_command_hotkey(app: AppHandle) -> Result<(), String> {
    dual_command_hotkey::install(app)
}

#[cfg(target_os = "macos")]
mod dual_command_hotkey {
    use super::*;
    use std::os::raw::{c_long, c_void};

    const K_CG_SESSION_EVENT_TAP: u32 = 1;
    const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
    const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    const K_CG_EVENT_FLAGS_CHANGED: u32 = 12;
    const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
    const K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: u32 = 1;
    const NX_DEVICELCMDKEYMASK: u64 = 0x0000_0008;
    const NX_DEVICERCMDKEYMASK: u64 = 0x0000_0010;

    const LEFT_COMMAND_KEYCODE: u16 = 55;
    const RIGHT_COMMAND_KEYCODE: u16 = 54;

    type CGEventRef = *const c_void;
    type CGEventTapProxy = *const c_void;
    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;
    type CFAllocatorRef = *mut c_void;
    type CFRunLoopMode = *const c_void;
    type CFIndex = c_long;

    type CGEventTapCallBack = unsafe extern "C" fn(
        proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    struct HotkeyState {
        app: AppHandle,
        armed: AtomicBool,
        tap: AtomicPtr<c_void>,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: CGEventTapCallBack,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventSourceKeyState(state_id: u32, key: u16) -> bool;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFAllocatorDefault: CFAllocatorRef;
        static kCFRunLoopCommonModes: CFRunLoopMode;

        fn CFRunLoopGetMain() -> CFRunLoopRef;
        fn CFMachPortCreateRunLoopSource(
            allocator: CFAllocatorRef,
            port: CFMachPortRef,
            order: CFIndex,
        ) -> CFRunLoopSourceRef;
        fn CFMachPortInvalidate(port: CFMachPortRef);
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFRunLoopMode);
        fn CFRelease(cftype: *const c_void);
    }

    pub fn install(app: AppHandle) -> Result<(), String> {
        let state = Arc::new(HotkeyState {
            app,
            armed: AtomicBool::new(false),
            tap: AtomicPtr::new(std::ptr::null_mut()),
        });
        let state_ptr = Arc::into_raw(state) as *mut c_void;

        unsafe {
            let event_mask = 1_u64 << K_CG_EVENT_FLAGS_CHANGED;
            let tap = CGEventTapCreate(
                K_CG_SESSION_EVENT_TAP,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                event_mask,
                callback,
                state_ptr,
            );
            if tap.is_null() {
                drop(Arc::from_raw(state_ptr as *const HotkeyState));
                return Err("创建左右 Cmd event tap 失败，请检查辅助功能/输入监控权限".to_string());
            }
            (*(state_ptr as *const HotkeyState))
                .tap
                .store(tap, Ordering::SeqCst);

            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
            if source.is_null() {
                CFMachPortInvalidate(tap);
                CFRelease(tap as *const c_void);
                drop(Arc::from_raw(state_ptr as *const HotkeyState));
                return Err("创建左右 Cmd run loop source 失败".to_string());
            }

            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
        }

        eprintln!("[appshot-hotkey] {DEFAULT_APPSHOTS_SHORTCUT} 热键已启用");
        Ok(())
    }

    unsafe extern "C" fn callback(
        _proxy: CGEventTapProxy,
        event_type: u32,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        if event_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
            || event_type == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
        {
            if !user_info.is_null() {
                let state = &*(user_info as *const HotkeyState);
                let tap = state.tap.load(Ordering::SeqCst);
                if !tap.is_null() {
                    CGEventTapEnable(tap, true);
                }
            }
            return event;
        }
        if event_type != K_CG_EVENT_FLAGS_CHANGED || user_info.is_null() {
            return event;
        }

        let state = &*(user_info as *const HotkeyState);
        let flags = CGEventGetFlags(event);
        let left_down = (flags & NX_DEVICELCMDKEYMASK) != 0
            || CGEventSourceKeyState(
            K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE,
            LEFT_COMMAND_KEYCODE,
        );
        let right_down = (flags & NX_DEVICERCMDKEYMASK) != 0
            || CGEventSourceKeyState(
            K_CG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE,
            RIGHT_COMMAND_KEYCODE,
        );

        if left_down && right_down {
            if !state.armed.swap(true, Ordering::SeqCst) {
                eprintln!("[appshot-hotkey] 左右 Cmd 触发 Appshot");
                trigger_capture(state.app.clone());
            }
        } else {
            state.armed.store(false, Ordering::SeqCst);
        }

        event
    }
}

/// 读取 PNG 为 base64 data URL（命令与飞入动画共用）。
#[cfg(target_os = "macos")]
fn read_png_data_url(path: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = std::fs::read(path).map_err(|e| format!("读取截图失败: {e}"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

/// 读取 appshot 截图为 base64 data URL，供前端作为图片附件发给模型。
/// 事件只回传磁盘路径（避免几 MB base64 塞进事件 payload），前端按需调本命令取数据。
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn appshots_read_image_data_url(path: String) -> Result<String, String> {
    read_png_data_url(&path)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn appshots_read_image_data_url(_path: String) -> Result<String, String> {
    Err("Appshots 仅支持 macOS".to_string())
}

/// 输入框缩略图槽位（屏幕逻辑坐标，左上原点），前端用 getBoundingClientRect + screenX/Y 上报。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 全局状态：缓存 composer 槽位，供飞入动画算落点。
#[derive(Default)]
pub struct AppshotsState {
    composer_slot: Mutex<Option<SlotRect>>,
}

/// 前端在 composer 挂载/变化时上报输入框槽位（飞入动画的落点）。
#[tauri::command]
pub fn appshots_report_composer_slot(
    state: tauri::State<'_, AppshotsState>,
    slot: SlotRect,
) -> Result<(), String> {
    *state
        .composer_slot
        .lock()
        .map_err(|e| format!("composer_slot 锁失败: {e}"))? = Some(slot);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn capture_now(app: &AppHandle) {
    let request_id = format!("appshot-{}", now_ms());
    let _ = app.emit(
        "appshots:capture_starting",
        serde_json::json!({ "requestId": request_id }),
    );

    let located = match locate_frontmost_window() {
        Ok(Some(loc)) => loc,
        Ok(None) => {
            emit_error(
                app,
                &request_id,
                "no_target",
                "没有可截取的前台窗口（或当前前台就是 Agent Neo 自身）。",
            );
            return;
        }
        Err(e) => {
            emit_error(app, &request_id, "locate_failed", &e);
            return;
        }
    };

    let dir = match appshots_dir() {
        Ok(d) => d,
        Err(e) => {
            emit_error(app, &request_id, "io_failed", &e);
            return;
        }
    };
    let png_path = dir.join(format!("{request_id}.png"));

    if let Err(e) = capture_window(located.window_id, &png_path) {
        emit_error(app, &request_id, "capture_failed", &e);
        return;
    }

    let window_frame = ScreenRect {
        x: located.x,
        y: located.y,
        width: located.width,
        height: located.height,
    };

    play_shutter_sound();
    activate_main_window(app);
    animate_overlay_best_effort(app, &png_path, window_frame);

    // 文本通道：AX 优先；AX 为空则本地 Vision OCR 兜底（免费 / 端上 / 零 token）。
    let mut text_source = "none";
    let mut text = extract_ax_text(located.pid).unwrap_or_default();
    if text.trim().is_empty() {
        if let Some(ocr) = ocr_image(&png_path) {
            if !ocr.trim().is_empty() {
                text = ocr;
                text_source = "ocr";
            }
        }
    } else {
        text_source = "ax";
    }
    let ax_text = if text.trim().is_empty() {
        None
    } else {
        Some(truncate_chars(text.trim(), AX_TEXT_MAX_CHARS))
    };

    let info = AppshotsCaptureInfo {
        request_id,
        app_name: located.app_name,
        bundle_id: located.bundle_id,
        window_title: located.title.filter(|t| !t.trim().is_empty()),
        screenshot_path: png_path.to_string_lossy().to_string(),
        ax_text,
        text_source: text_source.to_string(),
        window_frame,
        captured_at_ms: now_ms(),
    };

    let _ = app.emit("appshots:capture_ready", &info);
}

#[cfg(not(target_os = "macos"))]
pub fn capture_now(app: &AppHandle) {
    let _ = app;
}

// ---------------------------------------------------------------------------
// macOS 原生实现
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
struct LocatedWindow {
    pid: i32,
    window_id: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    app_name: String,
    bundle_id: Option<String>,
    title: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(serde::Deserialize)]
struct LocateRaw {
    found: bool,
    pid: Option<i32>,
    #[serde(rename = "windowId")]
    window_id: Option<i64>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    #[serde(rename = "appName")]
    app_name: Option<String>,
    #[serde(rename = "bundleId")]
    bundle_id: Option<String>,
    title: Option<String>,
}

/// 用 NSWorkspace 取前台 app（排除自身），再用 CGWindowList 取其最前的可见窗口。
#[cfg(target_os = "macos")]
fn locate_frontmost_window() -> Result<Option<LocatedWindow>, String> {
    let script = format!(
        r#"
        import Cocoa
        import CoreGraphics
        import Foundation

        func emit(_ obj: [String: Any]) {{
            if let data = try? JSONSerialization.data(withJSONObject: obj),
               let s = String(data: data, encoding: .utf8) {{ print(s) }}
        }}

        guard let app = NSWorkspace.shared.frontmostApplication else {{ emit(["found": false]); exit(0) }}
        let pid = app.processIdentifier
        let bundleId = app.bundleIdentifier ?? ""
        let appName = app.localizedName ?? ""
        // 排除自身：按 PID（dev 二进制无 bundle id，只靠 bundleId 会漏判）+ bundle id 双保险。
        if pid == {own_pid} || bundleId == "{own}" {{ emit(["found": false]); exit(0) }}

        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {{
            emit(["found": false]); exit(0)
        }}
        // CGWindowList 返回 front-to-back，取第一个属于该 pid 的 layer 0 窗口即最前窗口。
        for w in list {{
            guard let owner = w[kCGWindowOwnerPID as String] as? Int, Int32(owner) == pid else {{ continue }}
            let layer = w[kCGWindowLayer as String] as? Int ?? 0
            if layer != 0 {{ continue }}
            guard let num = w[kCGWindowNumber as String] as? Int else {{ continue }}
            guard let b = w[kCGWindowBounds as String] as? [String: Any] else {{ continue }}
            let x = (b["X"] as? Double) ?? 0
            let y = (b["Y"] as? Double) ?? 0
            let width = (b["Width"] as? Double) ?? 0
            let height = (b["Height"] as? Double) ?? 0
            if width < 1 || height < 1 {{ continue }}
            let title = (w[kCGWindowName as String] as? String) ?? ""
            emit([
                "found": true, "pid": Int(pid), "windowId": num,
                "x": x, "y": y, "width": width, "height": height,
                "appName": appName, "bundleId": bundleId, "title": title,
            ])
            exit(0)
        }}
        emit(["found": false])
        "#,
        own = OWN_BUNDLE_ID,
        own_pid = std::process::id()
    );

    let out = run_command_with_timeout("/usr/bin/swift", &["-e", script.as_str()], SWIFT_TIMEOUT)?;
    let raw: LocateRaw = serde_json::from_str(out.trim())
        .map_err(|e| format!("解析窗口定位结果失败: {e} (输出: {out})"))?;

    if !raw.found {
        return Ok(None);
    }
    Ok(Some(LocatedWindow {
        pid: raw.pid.ok_or("窗口定位结果缺少 pid")?,
        window_id: raw.window_id.ok_or("窗口定位结果缺少 windowId")?,
        x: raw.x.unwrap_or(0.0),
        y: raw.y.unwrap_or(0.0),
        width: raw.width.unwrap_or(0.0),
        height: raw.height.unwrap_or(0.0),
        app_name: raw.app_name.unwrap_or_default(),
        bundle_id: raw.bundle_id.filter(|s| !s.is_empty()),
        title: raw.title,
    }))
}

/// `screencapture -l <windowId>` 窗口级截图（-o 去阴影，-x 静音）。
#[cfg(target_os = "macos")]
fn capture_window(window_id: i64, output_path: &PathBuf) -> Result<(), String> {
    let id_str = window_id.to_string();
    let out_str = output_path.to_string_lossy().to_string();
    run_command_with_timeout(
        "screencapture",
        &["-l", &id_str, "-o", "-x", "-t", "png", &out_str],
        CAPTURE_TIMEOUT,
    )?;
    let meta = std::fs::metadata(output_path).map_err(|e| format!("截图未写入: {e}"))?;
    if meta.len() == 0 {
        return Err("截图文件为空（窗口可能已关闭或不可见）。".to_string());
    }
    Ok(())
}

/// 走 AX 无障碍树收集目标窗口的可读文本（需辅助功能权限）。
#[cfg(target_os = "macos")]
fn extract_ax_text(pid: i32) -> Option<String> {
    let script = format!(
        r#"
        import ApplicationServices
        import Foundation

        let pid: pid_t = {pid}
        let appEl = AXUIElementCreateApplication(pid)
        var focused: AnyObject?
        guard AXUIElementCopyAttributeValue(appEl, kAXFocusedWindowAttribute as CFString, &focused) == .success,
              let win = focused else {{ exit(0) }}

        var texts: [String] = []
        func walk(_ el: AXUIElement, _ depth: Int) {{
            if depth > 40 || texts.count > 5000 {{ return }}
            for attr in ["AXValue", "AXTitle", "AXDescription"] {{
                var v: AnyObject?
                if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success,
                   let s = v as? String {{
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty {{ texts.append(t) }}
                }}
            }}
            var children: AnyObject?
            if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &children) == .success,
               let arr = children as? [AXUIElement] {{
                for c in arr {{ walk(c, depth + 1) }}
            }}
        }}
        walk(win as! AXUIElement, 0)
        print(texts.joined(separator: "\n"))
        "#,
        pid = pid
    );

    match run_command_with_timeout("/usr/bin/swift", &["-e", script.as_str()], SWIFT_TIMEOUT) {
        Ok(text) => Some(text),
        Err(e) => {
            eprintln!("[appshot] AX 文本提取失败: {e}");
            None
        }
    }
}

/// AX 为空时的兜底：macOS Vision 框架本地 OCR（VNRecognizeTextRequest）。
#[cfg(target_os = "macos")]
fn ocr_image(image_path: &PathBuf) -> Option<String> {
    let path = image_path.to_string_lossy().to_string();
    // 文件名由我们生成（appshot-<ts>.png），不含引号，可直接内联。
    let script = format!(
        r#"
        import Vision
        import Cocoa
        import Foundation

        let path = "{path}"
        guard let img = NSImage(contentsOfFile: path),
              let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {{ exit(0) }}
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        req.recognitionLanguages = ["zh-Hans", "en-US"]
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        try? handler.perform([req])
        let lines = req.results?
            .compactMap {{ $0.topCandidates(1).first?.string }} ?? []
        print(lines.joined(separator: "\n"))
        "#,
        path = path
    );

    match run_command_with_timeout("/usr/bin/swift", &["-e", script.as_str()], SWIFT_TIMEOUT) {
        Ok(text) => Some(text),
        Err(e) => {
            eprintln!("[appshot] OCR 兜底失败: {e}");
            None
        }
    }
}

/// 快门音：截图成功后给听觉反馈。fire-and-forget。
#[cfg(target_os = "macos")]
fn play_shutter_sound() {
    let _ = Command::new("afplay")
        .arg("/System/Library/Sounds/Tink.aiff")
        .spawn();
}

#[cfg(target_os = "macos")]
fn activate_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// appshots 截图落盘目录：~/.code-agent/appshots（与 native_desktop 的 base 解析一致）。
#[cfg(target_os = "macos")]
fn appshots_dir() -> Result<PathBuf, String> {
    let base = if let Ok(dir) = std::env::var("CODE_AGENT_DATA_DIR") {
        PathBuf::from(dir)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".code-agent")
    } else {
        std::env::temp_dir()
    };
    let dir = base.join("appshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 appshots 目录失败: {e}"))?;
    Ok(dir)
}

#[cfg(target_os = "macos")]
fn emit_error(app: &AppHandle, request_id: &str, code: &str, message: &str) {
    eprintln!("[appshot] {code}: {message}");
    let _ = app.emit(
        "appshots:error",
        serde_json::json!({ "requestId": request_id, "code": code, "message": message }),
    );
}

#[cfg(target_os = "macos")]
fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 按字符边界截断（AX/OCR 文本可能含多字节中文）。
#[cfg(target_os = "macos")]
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n…(truncated)");
    out
}

// ---------------------------------------------------------------------------
// 飞入动画 overlay（Phase 3）
//
// 在一个铺满主显示器、透明、鼠标穿透、置顶的临时 WebviewWindow 里，让截图从
// 「源窗口在屏幕上的位置」收缩+上浮+飞向「composer 缩略图槽位」，落地淡出，由
// composer 里真正的 chip 接管。动画用 Web Animations API，HTML 内自跑（参数在创建时
// 内联进 data URL，免 eval 时序竞争）。
//
// 范围（MVP）：覆盖主显示器；坐标用屏幕逻辑坐标（CG 点 / getBoundingClientRect 同为
// 左上原点逻辑像素）。已知限制（后续 3.1 细化）：① 跨多显示器或副屏窗口落点会偏；
// ② 未用 objc2 抬 NSWindow level，盖不住全屏 Space 里的 app。两者都不影响核心链路。
const ANIM_DURATION_MS: u64 = 1100;

#[cfg(target_os = "macos")]
fn animate_overlay_best_effort(app: &AppHandle, screenshot_path: &PathBuf, src: ScreenRect) {
    // 落点：前端上报的 composer 槽位（屏幕逻辑坐标）。没上报过就不演。
    let slot = match app.state::<AppshotsState>().composer_slot.lock() {
        Ok(guard) => match *guard {
            Some(s) => s,
            None => return,
        },
        Err(_) => return,
    };

    let image = match read_png_data_url(&screenshot_path.to_string_lossy()) {
        Ok(url) => url,
        Err(e) => {
            eprintln!("[appshot-overlay] 读图失败: {e}");
            return;
        }
    };

    // overlay 覆盖主显示器；屏幕逻辑坐标 → overlay 本地 CSS 坐标 = 减去 overlay 原点。
    let monitor = match app.primary_monitor() {
        Ok(Some(m)) => m,
        _ => {
            eprintln!("[appshot-overlay] 无主显示器");
            return;
        }
    };
    let scale = monitor.scale_factor();
    let origin_x = monitor.position().x as f64 / scale;
    let origin_y = monitor.position().y as f64 / scale;
    let win_w = monitor.size().width as f64 / scale;
    let win_h = monitor.size().height as f64 / scale;

    let params = serde_json::json!({
        "src": { "x": src.x - origin_x, "y": src.y - origin_y, "width": src.width, "height": src.height },
        "dst": { "x": slot.x - origin_x, "y": slot.y - origin_y, "width": slot.width, "height": slot.height },
        "imageDataUrl": image,
        "radius": 12,
        "durationMs": ANIM_DURATION_MS,
    });

    let html = build_overlay_html(&params.to_string());
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let data_url = format!("data:text/html;base64,{}", STANDARD.encode(html.as_bytes()));
    let url = match data_url.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[appshot-overlay] data URL 解析失败: {e}");
            return;
        }
    };

    let label = format!("appshot-overlay-{}", now_ms());
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .position(origin_x, origin_y)
        .inner_size(win_w, win_h)
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
        .build();

    let window = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[appshot-overlay] 创建 overlay 失败: {e}");
            return;
        }
    };
    let _ = window.set_ignore_cursor_events(true);

    // 动画在 HTML 内自跑；演完按 label 关窗（duration + buffer）。
    let app_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ANIM_DURATION_MS + 500));
        if let Some(w) = app_handle.get_webview_window(&label) {
            let _ = w.close();
        }
    });
}

/// 构建 overlay HTML：参数在创建时内联，DOM 就绪即自跑动画（无需 eval）。
#[cfg(target_os = "macos")]
fn build_overlay_html(params_json: &str) -> String {
    OVERLAY_HTML_TEMPLATE.replace("__APPSHOT_PARAMS__", params_json)
}

// 用占位符 + replace（而非 format!），避免 JS 里大量 `{}` 与 format! 冲突。
#[cfg(target_os = "macos")]
const OVERLAY_HTML_TEMPLATE: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100vw;height:100vh}
  .shot{position:absolute;will-change:transform,opacity,border-radius;
    box-shadow:0 22px 70px rgba(0,0,0,.32),0 6px 18px rgba(0,0,0,.2);
    background-size:cover;background-position:center;background-repeat:no-repeat;
    pointer-events:none;transform-origin:center center;opacity:0}
</style></head><body><div id="stage"></div><script>
(function(){
  var P = __APPSHOT_PARAMS__;
  var stage=document.getElementById('stage');
  var src=P.src, dst=P.dst, radius=P.radius||12, totalMs=P.durationMs||1100;
  if(!src||!dst||!P.imageDataUrl||src.width<1||src.height<1){return;}
  var shot=document.createElement('div'); shot.className='shot';
  shot.style.left=src.x+'px'; shot.style.top=src.y+'px';
  shot.style.width=src.width+'px'; shot.style.height=src.height+'px';
  shot.style.borderRadius=radius+'px';
  shot.style.backgroundImage="url('"+P.imageDataUrl+"')";
  stage.appendChild(shot);
  var sCx=src.x+src.width/2, sCy=src.y+src.height/2;
  var dCx=dst.x+dst.width/2, dCy=dst.y+dst.height/2;
  var dx=dCx-sCx, dy=dCy-sCy;
  var sx=dst.width/src.width, sy=dst.height/src.height;
  var liftScale=0.5, liftY=-60;
  function r6(v){return Math.max(6,v)+'px';}
  function run(){
    var anim=shot.animate([
      {transform:'translate(0,0) scale(1,1)',borderRadius:radius+'px',opacity:0,offset:0,easing:'cubic-bezier(.22,.8,.36,1)'},
      {transform:'translate(0,0) scale(1,1)',borderRadius:radius+'px',opacity:1,offset:.08,easing:'cubic-bezier(.32,.72,0,1)'},
      {transform:'translate(0,'+liftY+'px) scale('+liftScale+','+liftScale+')',borderRadius:Math.max(8,radius*.9)+'px',opacity:1,offset:.36,easing:'cubic-bezier(.4,0,.2,1)'},
      {transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',borderRadius:r6(radius*.6),opacity:1,offset:.85,easing:'cubic-bezier(.34,1.1,.4,1)'},
      {transform:'translate('+dx+'px,'+dy+'px) scale('+(sx*1.06)+','+(sy*1.06)+')',borderRadius:r6(radius*.6),opacity:1,offset:.93,easing:'cubic-bezier(.4,0,.2,1)'},
      {transform:'translate('+dx+'px,'+dy+'px) scale('+sx+','+sy+')',borderRadius:r6(radius*.6),opacity:0,offset:1}
    ],{duration:totalMs,easing:'linear',fill:'forwards'});
    anim.finished.catch(function(){}).then(function(){try{shot.remove();}catch(e){}});
  }
  var img=new Image(); img.onload=run; img.onerror=run; img.src=P.imageDataUrl;
})();
</script></body></html>"#;
