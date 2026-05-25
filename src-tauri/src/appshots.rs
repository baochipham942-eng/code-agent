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
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Emitter;

/// 默认 Appshots 热键（避开主窗口激活已占用的 CmdOrCtrl+Shift+A）。
pub const DEFAULT_APPSHOTS_SHORTCUT: &str = "CmdOrCtrl+Shift+S";

#[cfg(target_os = "macos")]
const OWN_BUNDLE_ID: &str = "com.linchen.code-agent";
#[cfg(target_os = "macos")]
const AX_TEXT_MAX_CHARS: usize = 4000;
#[cfg(target_os = "macos")]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const SWIFT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
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

#[cfg(target_os = "macos")]
pub fn capture_now(app: &AppHandle) {
    let request_id = format!("appshot-{}", now_ms());
    let _ = app.emit(
        "appshots:capture_starting",
        serde_json::json!({ "requestId": request_id }),
    );

    play_shutter_sound();

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
        window_frame: ScreenRect {
            x: located.x,
            y: located.y,
            width: located.width,
            height: located.height,
        },
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
        if bundleId == "{own}" {{ emit(["found": false]); exit(0) }}

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
        own = OWN_BUNDLE_ID
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

/// 快门音：先给即时听觉反馈，遮蔽后续抓图/OCR 延迟。fire-and-forget。
#[cfg(target_os = "macos")]
fn play_shutter_sound() {
    let _ = Command::new("afplay")
        .arg("/System/Library/Sounds/Tink.aiff")
        .spawn();
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
