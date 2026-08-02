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
    atomic::{AtomicBool, AtomicPtr, AtomicU64, Ordering},
    Arc,
};
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::{webview::PageLoadEvent, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 默认 Appshots 热键：同时按下左右 Command。
pub const DEFAULT_APPSHOTS_SHORTCUT: &str = "LeftCmd+RightCmd";

#[cfg(target_os = "macos")]
const OWN_BUNDLE_ID: &str = "com.linchen.code-agent";

/// 运行时真实 bundle id：测试包（com.linchen.code-agent.dev）由 main 注入 CODE_AGENT_BUNDLE_ID，
/// 缺省时回退到生产常量，保证排除"自己窗口"时认的是当前进程的 bundle 而非写死的生产值。
#[cfg(target_os = "macos")]
fn own_bundle_id() -> String {
    std::env::var("CODE_AGENT_BUNDLE_ID").unwrap_or_else(|_| OWN_BUNDLE_ID.to_string())
}
#[cfg(target_os = "macos")]
const AX_TEXT_MAX_CHARS: usize = 4000;
#[cfg(target_os = "macos")]
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const SWIFT_TIMEOUT: Duration = Duration::from_secs(5);

/// Appshots 总开关：前端设置同步过来，控制左右 Cmd 热键是否触发捕获。
#[cfg(target_os = "macos")]
static APPSHOTS_ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// `#[tauri::command]`：前端把「启用 Appshots」设置同步给原生热键监听。
#[tauri::command]
pub fn appshots_set_enabled(enabled: bool) {
    #[cfg(target_os = "macos")]
    APPSHOTS_ENABLED.store(enabled, std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(target_os = "macos"))]
    let _ = enabled;
}

/// 发送目标=新会话（详设 §7 方案 A：new 时跳过飞入只落 chip）。前端在启动与设置变更时同步。
#[cfg(target_os = "macos")]
static APPSHOTS_TARGET_NEW: AtomicBool = AtomicBool::new(false);
/// 动效总开关（OS reduced-motion 时前端同步为 false）。默认开。
#[cfg(target_os = "macos")]
static APPSHOTS_MOTION_ENABLED: AtomicBool = AtomicBool::new(true);

#[tauri::command]
pub fn appshots_set_target_session(new_session: bool) {
    #[cfg(target_os = "macos")]
    APPSHOTS_TARGET_NEW.store(new_session, std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(target_os = "macos"))]
    let _ = new_session;
}

#[tauri::command]
pub fn appshots_set_motion_enabled(enabled: bool) {
    #[cfg(target_os = "macos")]
    APPSHOTS_MOTION_ENABLED.store(enabled, std::sync::atomic::Ordering::SeqCst);
    #[cfg(not(target_os = "macos"))]
    let _ = enabled;
}

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

/// 让主窗口在未激活（非 key）时也接收 mouse-moved 事件。
/// macOS 默认只有 key window 收 mouseMoved，WKWebView 的 CSS :hover 因此
/// 在窗口未聚焦时不生效（Codex/Electron 无此问题）；打开后 hover 交互一致。
#[cfg(target_os = "macos")]
pub fn enable_hover_when_inactive(app: &AppHandle) {
    use objc2_app_kit::NSWindow;
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(ptr) = window.ns_window() {
            unsafe {
                let ns_window: &NSWindow = &*(ptr as *const NSWindow);
                ns_window.setAcceptsMouseMovedEvents(true);
            }
            eprintln!("[appshot] 主窗口 acceptsMouseMovedEvents=true 已设置");
        } else {
            eprintln!("[appshot] 取主窗口 ns_window 失败，未聚焦 hover 不可用");
        }
    }
}

/// 让主窗口内所有视图在窗口未激活时也接受首次点击（不拿来激活窗口、直接进页面）。
/// macOS 默认「第一击激活窗口、第二击才生效」（NSView.acceptsFirstMouse=NO），
/// 表现为 composer chip 的删除按钮要点两次；对齐 Codex/Electron 的一次到位。
/// 注意：命中测试落在 WebKit 内部子视图上，只 patch WKWebView 类无效，
/// 必须遍历视图层级对每个 view 类注入。
#[cfg(target_os = "macos")]
pub fn enable_first_mouse_click(app: &AppHandle) {
    use objc2::ffi::{class_replaceMethod, object_getClass};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::sel;
    use objc2_app_kit::{NSView, NSWindow};
    use std::collections::HashSet;
    use std::ffi::c_void;

    unsafe extern "C-unwind" fn accepts_first_mouse_yes(
        _this: *mut AnyObject,
        _sel: Sel,
        _event: *mut c_void,
    ) -> Bool {
        Bool::YES
    }

    fn patch_hierarchy(view: &NSView, patched: &mut HashSet<*const AnyClass>) {
        unsafe {
            let cls = object_getClass(view as *const NSView as *mut AnyObject);
            if !cls.is_null() && patched.insert(cls) {
                let imp: objc2::runtime::Imp = std::mem::transmute(
                    accepts_first_mouse_yes
                        as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut c_void) -> Bool,
                );
                class_replaceMethod(cls as *mut AnyClass, sel!(acceptsFirstMouse:), imp, c"B@:@".as_ptr());
            }
            for sub in view.subviews().iter() {
                patch_hierarchy(&sub, patched);
            }
        }
    }

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(ptr) = window.ns_window() else {
        eprintln!("[appshot] 取主窗口 ns_window 失败，首击直通未注入");
        return;
    };
    unsafe {
        let ns_window: &NSWindow = &*(ptr as *const NSWindow);
        if let Some(content) = ns_window.contentView() {
            let mut patched = HashSet::new();
            patch_hierarchy(&content, &mut patched);
            eprintln!("[appshot] acceptsFirstMouse=YES 已注入 {} 个视图类", patched.len());
        }
    }
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
            if !state.armed.swap(true, Ordering::SeqCst)
                && super::APPSHOTS_ENABLED.load(Ordering::SeqCst)
            {
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

/// 按 requestId 读截图 data URL（路径由 appshots 目录派生，前端无需知道数据目录）。
/// 用于会话回放时气泡惰性还原图片——ledger 只存摘要，截图本体仍在 appshots 目录。
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn appshots_read_image_data_url_by_id(request_id: String) -> Result<String, String> {
    let dir = appshots_dir()?;
    let path = dir.join(format!("{request_id}.png"));
    read_png_data_url(&path.to_string_lossy())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn appshots_read_image_data_url(_path: String) -> Result<String, String> {
    Err("Appshots 仅支持 macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn appshots_read_image_data_url_by_id(_request_id: String) -> Result<String, String> {
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
    /// 前端请求跳过飞入的 requestId（reduced-motion / targetSession=new）：
    /// 命中后不建 overlay、立刻 handoff，让 chip 直接显形。
    motion_skip: Mutex<std::collections::HashSet<String>>,
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

/// 前端在 capture_starting 时按设置/系统偏好请求跳过本次飞入（详设 §7 方案 A + reduced-motion）。
#[tauri::command]
pub fn appshots_skip_motion(
    state: tauri::State<'_, AppshotsState>,
    request_id: String,
) -> Result<(), String> {
    let mut skip = state
        .motion_skip
        .lock()
        .map_err(|e| format!("motion_skip 锁失败: {e}"))?;
    // 防御性上限：捕获在 animate 前失败时条目不会被消费，避免无界增长。
    if skip.len() >= 64 {
        skip.clear();
    }
    skip.insert(request_id);
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
    // skip 决策源改为 Rust 侧直读（renderer 设置 IPC 启动早期会永久挂起，同步不可靠）：
    // ① targetSession=new 读 config.json；② OS reduceMotion 读 defaults。每次捕获新鲜读取。
    let target_new = read_appshots_target_new();
    APPSHOTS_TARGET_NEW.store(target_new, Ordering::SeqCst);
    APPSHOTS_MOTION_ENABLED.store(!read_reduce_motion(), Ordering::SeqCst);
    // 主窗口前置不在此处做：挪到 overlay 起飞时（start_flight 内），
    // 让飞入从源窗口上空起步、Neo 在飞行中段衔接前置（对齐 Codex 手感）；
    // skip/失败路径由 animate 内的 bail_activate_and_handoff 兜底前置。

    // 图先就绪：PNG 落盘 + 快门后即 emit（与飞入同时），文本通道随后经 text_ready 补齐。
    let window_title = located.title.filter(|t| !t.trim().is_empty());
    let screenshot_path = png_path.to_string_lossy().to_string();
    let captured_at = now_ms();
    let _ = app.emit(
        "appshots:image_ready",
        serde_json::json!({
            "requestId": request_id,
            "appName": located.app_name,
            "bundleId": located.bundle_id,
            "windowTitle": window_title,
            "screenshotPath": screenshot_path,
            "windowFrame": window_frame,
            "capturedAtMs": captured_at,
            "targetSession": if target_new { "new" } else { "current" },
            "motion": { "durationMs": ANIM_DURATION_MS, "handoffAtMs": HANDOFF_AT_MS },
        }),
    );
    animate_overlay_best_effort(app, &request_id, &png_path, window_frame);

    // 文本通道：AX 优先；AX 为空则本地 Vision OCR 兜底（免费 / 端上 / 零 token）。
    // AX 原文先经 clean_ax_text 保守降噪（按行去重 / 单行限长 / 丢空白行）：
    // 浏览器 tab 条、书签栏会在 AX 树里刷出大量重复短串。
    let mut text_source = "none";
    let mut text = extract_ax_text(located.pid)
        .map(|raw| clean_ax_text(&raw))
        .unwrap_or_default();
    if text.trim().is_empty() {
        if let Some(ocr) = ocr_image(app, &png_path) {
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

    let _ = app.emit(
        "appshots:text_ready",
        serde_json::json!({
            "requestId": request_id,
            "axText": ax_text,
            "textSource": text_source,
        }),
    );

    // 兼容：全量 capture_ready 一期保留（image+text 都齐后再发，旧 listener 不炸）。
    let info = AppshotsCaptureInfo {
        request_id,
        app_name: located.app_name,
        bundle_id: located.bundle_id,
        window_title,
        screenshot_path,
        ax_text,
        text_source: text_source.to_string(),
        window_frame,
        captured_at_ms: captured_at,
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
        own = own_bundle_id(),
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
fn ocr_image(app: &AppHandle, image_path: &PathBuf) -> Option<String> {
    let path = image_path.to_string_lossy().to_string();

    // 优先用预编译 vision-ocr 二进制（比 swift -e 冷启快，与项目既有 OCR 用法一致）。
    if let Some(bin) = resolve_vision_ocr(app) {
        let bin_str = bin.to_string_lossy().to_string();
        match run_command_with_timeout(&bin_str, &["--photo", &path], SWIFT_TIMEOUT) {
            Ok(out) => {
                if let Some(text) = parse_vision_ocr_full_text(&out) {
                    return Some(text);
                }
            }
            Err(e) => eprintln!("[appshot] vision-ocr 失败，回退 swift: {e}"),
        }
    }

    // 回退：swift -e 内联（无二进制 / 解析失败时）。文件名由我们生成，不含引号，可直接内联。
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
            eprintln!("[appshot] OCR swift 兜底失败: {e}");
            None
        }
    }
}

/// 解析 vision-ocr 二进制输出 JSON 的 fullText 字段。
#[cfg(target_os = "macos")]
fn parse_vision_ocr_full_text(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json.trim()).ok()?;
    v.get("fullText")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

/// 解析预编译 vision-ocr 二进制位置：prod 走 resource_dir，dev 走可执行文件祖先 / cwd。
#[cfg(target_os = "macos")]
fn resolve_vision_ocr(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            res.join("scripts/vision-ocr"),
            res.join("_up_/scripts/vision-ocr"),
            res.join("vision-ocr"),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent();
        while let Some(d) = dir {
            let cand = d.join("scripts/vision-ocr");
            if cand.exists() {
                return Some(cand);
            }
            dir = d.parent();
        }
    }
    let fallback = PathBuf::from("scripts/vision-ocr");
    if fallback.exists() {
        return Some(fallback);
    }
    None
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

/// 主窗口在屏幕上的原点（逻辑坐标）：outer_position 是物理像素，除以 scale_factor。
/// 前端上报的 composer 槽位是视口内 CSS 坐标，加这个原点即得屏幕逻辑坐标。
#[cfg(target_os = "macos")]
fn main_window_origin_logical(app: &AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window("main")?;
    let pos = window.outer_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some((pos.x as f64 / scale, pos.y as f64 / scale))
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

/// 直读 config.json 的 appshots.targetSession（renderer 设置 IPC 启动早期会挂起，
/// 同步通道不可靠；config.json 是设置的真实持久层，每次捕获新鲜读取即可）。
#[cfg(target_os = "macos")]
fn read_appshots_target_new() -> bool {
    let base = if let Ok(dir) = std::env::var("CODE_AGENT_DATA_DIR") {
        PathBuf::from(dir)
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".code-agent")
    } else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(base.join("config.json")) else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    json.pointer("/appshots/targetSession").and_then(|v| v.as_str()) == Some("new")
}

/// 直读 macOS「减少动态效果」（com.apple.universalaccess reduceMotion）。
#[cfg(target_os = "macos")]
fn read_reduce_motion() -> bool {
    Command::new("defaults")
        .args(["read", "com.apple.universalaccess", "reduceMotion"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn emit_error(app: &AppHandle, request_id: &str, code: &str, message: &str) {    eprintln!("[appshot] {code}: {message}");
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

/// AX 文本保守降噪（swift 侧保持原样，清洗放 Rust 后处理）：
/// 按行去重（全局 HashSet，保留首次出现顺序）、单行截到 300 字符、丢弃纯空白行。
/// 只去完全重复的行，不做模糊匹配，避免误伤正文里合理的重复短句。
#[cfg(target_os = "macos")]
fn clean_ax_text(raw: &str) -> String {
    const LINE_MAX_CHARS: usize = 300;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let clipped: String = if trimmed.chars().count() > LINE_MAX_CHARS {
            trimmed.chars().take(LINE_MAX_CHARS).collect()
        } else {
            trimmed.to_string()
        };
        if seen.insert(clipped.clone()) {
            out.push(clipped);
        }
    }
    out.join("\n")
}

#[cfg(all(test, target_os = "macos"))]
mod clean_ax_text_tests {
    use super::clean_ax_text;

    #[test]
    fn dedupes_repeated_lines_keeping_first_occurrence_order() {
        let raw = "Tab One\nBookmark\nTab One\nBody text\nBookmark\nTab One";
        assert_eq!(clean_ax_text(raw), "Tab One\nBookmark\nBody text");
    }

    #[test]
    fn drops_blank_and_whitespace_only_lines() {
        let raw = "alpha\n\n   \n\t\nbeta\n";
        assert_eq!(clean_ax_text(raw), "alpha\nbeta");
    }

    #[test]
    fn trims_line_edges_but_keeps_inner_spacing() {
        let raw = "  hello world  \nhello world";
        assert_eq!(clean_ax_text(raw), "hello world");
    }

    #[test]
    fn clips_single_line_to_300_chars_on_char_boundary() {
        let long_line: String = "汉".repeat(400);
        let cleaned = clean_ax_text(&long_line);
        assert_eq!(cleaned.chars().count(), 300);
        assert!(cleaned.chars().all(|c| c == '汉'));
    }

    #[test]
    fn dedupe_applies_after_clipping() {
        let long_a = format!("{}a", "x".repeat(400));
        let long_b = format!("{}b", "x".repeat(400));
        // 两条都截到前 300 个 'x'，截断后内容相同 → 去重只留一条
        let cleaned = clean_ax_text(&format!("{long_a}\n{long_b}"));
        assert_eq!(cleaned, "x".repeat(300));
    }

    #[test]
    fn empty_input_yields_empty_output() {
        assert_eq!(clean_ax_text(""), "");
        assert_eq!(clean_ax_text("\n  \n"), "");
    }
}

// ---------------------------------------------------------------------------
// 飞入动画 overlay（Phase 3）
//
// 在一个铺满显示器并集、透明、鼠标穿透、置顶的临时 WebviewWindow 里，让截图从
// 「源窗口在屏幕上的位置」收缩+上浮+飞向「composer 缩略图槽位」；抵达落点（handoff）
// 时 opacity 仍保持 1，由 composer 里已占位的 chip 零位移显形接管，overlay 再收尾关窗。动画用 Web Animations API，HTML 内自跑（参数在创建时
// 内联进 data URL，免 eval 时序竞争）。
//
// 范围（MVP）：覆盖主显示器；坐标用屏幕逻辑坐标（CG 点 / getBoundingClientRect 同为
// 左上原点逻辑像素）。已知限制（后续 3.1 细化）：① 跨多显示器或副屏窗口落点会偏；
// ② 未用 objc2 抬 NSWindow level，盖不住全屏 Space 里的 app。两者都不影响核心链路。
// 时长与 handoff 点按详设 §5.4：580ms 短行程，0.95 处（opacity 仍 1）emit handoff 交给 chip。
const ANIM_DURATION_MS: u64 = 580;
const HANDOFF_AT_MS: u64 = 551;

/// 飞入抵达落点（或跳过/失败时的兜底）：通知 renderer 把 reserved chip 显形。
#[cfg(target_os = "macos")]
fn emit_handoff(app: &AppHandle, request_id: &str) {
    let _ = app.emit(
        "appshots:handoff",
        serde_json::json!({ "requestId": request_id }),
    );
}

/// animate 内 skip/失败兜底：前置主窗口（正常路径在 on_page_load 里做）+ 立刻 handoff。
#[cfg(target_os = "macos")]
fn bail_activate_and_handoff(app: &AppHandle, request_id: &str) {
    activate_main_window(app);
    emit_handoff(app, request_id);
}

#[cfg(target_os = "macos")]
fn animate_overlay_best_effort(app: &AppHandle, request_id: &str, screenshot_path: &PathBuf, src: ScreenRect) {
    // 跳过飞入的场景（详设 §7 方案 A + reduced-motion）：不演飞入，立刻 handoff 让 chip 显形。
    // 三来源：① 前端 per-request skip（motion_skip 集合）；② targetSession=new（APPSHOTS_TARGET_NEW）；
    // ③ OS reduced-motion（APPSHOTS_MOTION_ENABLED=false）。②③ 由前端启动/变更时同步，无 IPC 竞态。
    let skip = app
        .state::<AppshotsState>()
        .motion_skip
        .lock()
        .map(|mut s| s.remove(request_id))
        .unwrap_or(false)
        || APPSHOTS_TARGET_NEW.load(Ordering::SeqCst)
        || !APPSHOTS_MOTION_ENABLED.load(Ordering::SeqCst);
    if skip {
        bail_activate_and_handoff(app, request_id);
        return;
    }

    // 落点：animate 入口 re-read 一次最新 composer 槽位（前端上报的是**主窗口视口内**
    // CSS 逻辑坐标；屏幕坐标 = 主窗口 outer_position（物理/scale→逻辑）+ 视口坐标。
    // 不让前端加 window.screenX/screenY——它们在部分环境是物理像素，混算会把落点打出屏幕）。
    // 没上报过就不演，但同样要 handoff——否则 chip 永远停在 reserved 不可见。
    let slot = match app.state::<AppshotsState>().composer_slot.lock() {
        Ok(guard) => match *guard {
            Some(s) => s,
            None => {
                bail_activate_and_handoff(app, request_id);
                return;
            }
        },
        Err(_) => {
            bail_activate_and_handoff(app, request_id);
            return;
        }
    };
    let slot = match main_window_origin_logical(app) {
        Some((wx, wy)) => SlotRect {
            x: slot.x + wx,
            y: slot.y + wy,
            ..slot
        },
        None => {
            eprintln!("[appshot-overlay] 取不到主窗口位置，跳过飞入");
            bail_activate_and_handoff(app, request_id);
            return;
        }
    };

    let image = match read_png_data_url(&screenshot_path.to_string_lossy()) {
        Ok(url) => url,
        Err(e) => {
            eprintln!("[appshot-overlay] 读图失败: {e}");
            bail_activate_and_handoff(app, request_id);
            return;
        }
    };

    // overlay 覆盖「所有显示器的并集」，源窗口或 composer 落在任意副屏都在范围内。
    // 屏幕逻辑坐标 → overlay 本地 CSS 坐标 = 减去 overlay 原点。
    let monitors = app.available_monitors().unwrap_or_default();
    if monitors.is_empty() {
        eprintln!("[appshot-overlay] 无可用显示器");
        bail_activate_and_handoff(app, request_id);
        return;
    }
    // 以主屏 scale 做物理→逻辑换算（同 DPI 多屏精确；混合 DPI 为近似，可接受）。
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or_else(|| monitors[0].scale_factor());
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
    for m in &monitors {
        let (p, s) = (m.position(), m.size());
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x + s.width as i32);
        max_y = max_y.max(p.y + s.height as i32);
    }
    let origin_x = min_x as f64 / scale;
    let origin_y = min_y as f64 / scale;
    let win_w = (max_x - min_x) as f64 / scale;
    let win_h = (max_y - min_y) as f64 / scale;

    let geom = serde_json::json!({
        "src": { "x": src.x - origin_x, "y": src.y - origin_y, "width": src.width, "height": src.height },
        "dst": { "x": slot.x - origin_x, "y": slot.y - origin_y, "width": slot.width, "height": slot.height },
        "radius": 12,
        "durationMs": ANIM_DURATION_MS,
    });
    let req = FlyRequest {
        geom_json: geom.to_string(),
        image_data_url: image,
        request_id: request_id.to_string(),
    };

    // 复用常驻 overlay 窗（agent_halo 同款模式）：每次抓拍摄新建窗口，macOS 上 destroy
    // 返回 Ok 仍残留僵尸窗（CGWindowList 持续增长）；常驻窗只 show/hide + eval 重启动画，
    // 还省掉每次抓取的页面加载延迟（首次加载后静态 HTML 常驻）。
    if !ensure_overlay_window(app, origin_x, origin_y, win_w, win_h) {
        bail_activate_and_handoff(app, request_id);
        return;
    }
    fly_overlay(app, req, origin_x, origin_y, win_w, win_h);
}

/// 一次飞入请求：几何参数（小 JSON）与截图 dataURL（大，分片下发）分离，
/// 避免单个超大 eval 字符串被 WKWebView 静默丢弃。
#[cfg(target_os = "macos")]
struct FlyRequest {
    geom_json: String,
    image_data_url: String,
    request_id: String,
}

/// 常驻 overlay 窗的固定 label 与状态：页面就绪标记、飞行代次（防旧计时器误关新动画）、
/// 页面未就绪时排队的飞行请求。
#[cfg(target_os = "macos")]
const OVERLAY_LABEL: &str = "appshot-overlay";
#[cfg(target_os = "macos")]
static OVERLAY_READY: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static FLY_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(target_os = "macos")]
static PENDING_FLY: std::sync::Mutex<Option<(FlyRequest, u64)>> = std::sync::Mutex::new(None);

/// 懒建常驻 overlay 窗（几何随首个捕获的显示器并集；后续飞行在 show 时刷新尺寸位置）。
/// 页面用打包进 bundle 的静态 assets（public/appshot-overlay.html，与 pip.html 同款
/// WebviewUrl::App）：data: URL 源上 WKWebView 不执行 eval，动画会静默不渲染。
#[cfg(target_os = "macos")]
fn ensure_overlay_window(app: &AppHandle, x: f64, y: f64, w: f64, h: f64) -> bool {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return true;
    }
    let built = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App(PathBuf::from("appshot-overlay.html")),
    )
        .position(x, y)
        .inner_size(w, h)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .shadow(false)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        .closable(false)
        .minimizable(false)
        .visible(false)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            OVERLAY_READY.store(true, Ordering::SeqCst);
            eprintln!("[appshot-overlay] 常驻窗页面就绪");
            // 显示一次后永不 hide：hidden/occluded 的 WKWebView 会暂停 rAF 与合成，
            // 而 WAAPI 动画走墙钟——hide 后再 show，动画直接跳到末段（飞入不可见的根因）。
            // 常驻窗透明+点击穿透+空 stage 时无任何视觉（与 agent_halo 常驻同理）。
            let _ = window.show();
            let app = window.app_handle().clone();
            let pending = PENDING_FLY.lock().ok().and_then(|mut g| g.take());
            if let Some((req, gen)) = pending {
                if gen == FLY_GENERATION.load(Ordering::SeqCst) {
                    start_flight(&app, req, gen);
                }
            }
        })
        .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[appshot-overlay] 创建 overlay 失败: {e}");
            return false;
        }
    };
    let _ = window.set_ignore_cursor_events(true);
    // 抬到 screen-saver 级 + 可进所有 Space，让动画盖过全屏 app。AppKit 调用必须回主线程。
    let app_for_level = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app_for_level.get_webview_window(OVERLAY_LABEL) {
            if let Ok(ptr) = w.ns_window() {
                unsafe { raise_overlay_window_level(ptr) };
            }
        }
    });
    true
}

/// 发起一次飞入：页面未就绪则排队（on_page_load 排空），否则直接 eval 重启动画。
#[cfg(target_os = "macos")]
fn fly_overlay(app: &AppHandle, req: FlyRequest, x: f64, y: f64, win_w: f64, win_h: f64) {
    let gen = FLY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // 飞行前刷新常驻窗几何（显示器并集可能变化），与动画参数同源。
    let app_for_geom = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(overlay) = app_for_geom.get_webview_window(OVERLAY_LABEL) {
            let _ = overlay.set_position(tauri::LogicalPosition::new(x, y));
            let _ = overlay.set_size(tauri::LogicalSize::new(win_w, win_h));
        }
    });
    if !OVERLAY_READY.load(Ordering::SeqCst) {
        let rid = req.request_id.clone();
        if let Ok(mut g) = PENDING_FLY.lock() {
            *g = Some((req, gen));
        }
        // 看门狗：页面永不就绪时兜底 handoff，防 chip 永远停在 reserved。
        let app_handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(2000));
            let still_pending = PENDING_FLY
                .lock()
                .map(|g| g.as_ref().is_some_and(|(_, g2)| *g2 == gen))
                .unwrap_or(false);
            if still_pending {
                eprintln!("[appshot-overlay] 页面加载超时，兜底 handoff");
                if let Ok(mut g) = PENDING_FLY.lock() {
                    if g.as_ref().is_some_and(|(_, g2)| *g2 == gen) {
                        *g = None;
                    }
                }
                bail_activate_and_handoff(&app_handle, &rid);
            }
        });
        return;
    }
    start_flight(app, req, gen);
}

/// eval 重启动画（几何 → 图片分片 → 启动）+ 显示常驻窗 + 前置主窗口 + handoff 计时（代次校验）。
/// 分三路 eval 是因为单个超大 eval 字符串（内联 ~MB 级 base64）会被静默丢弃。
#[cfg(target_os = "macos")]
fn start_flight(app: &AppHandle, req: FlyRequest, gen: u64) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        bail_activate_and_handoff(app, &req.request_id);
        return;
    };
    let eval_or_bail = |script: &str| -> Result<(), ()> {
        window.eval(script).map_err(|e| {
            eprintln!("[appshot-overlay] eval 失败: {e}");
        })
    };
    if eval_or_bail(&format!(
        "window.__appshotFlyGeom&&window.__appshotFlyGeom({})",
        req.geom_json
    ))
    .is_err()
    {
        bail_activate_and_handoff(app, &req.request_id);
        return;
    }
    // 图片 base64 分片下发（64KB/片；base64 字符集不含引号，可安全内联单引号字符串）
    let b64 = req
        .image_data_url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&req.image_data_url);
    let mut failed = false;
    for chunk in b64.as_bytes().chunks(64 * 1024) {
        let s = String::from_utf8_lossy(chunk);
        if eval_or_bail(&format!(
            "window.__appshotImgChunk&&window.__appshotImgChunk('{s}')"
        ))
        .is_err()
        {
            failed = true;
            break;
        }
    }
    if failed
        || eval_or_bail("window.__appshotFlyStart&&window.__appshotFlyStart()").is_err()
    {
        bail_activate_and_handoff(app, &req.request_id);
        return;
    }
    // 此刻才前置主窗口：飞入从源窗口上空起步，Neo 在飞行中段（~300ms）衔接前置，
    // 落点显形时 composer 已在画面中（对齐 Codex 手感）。
    activate_main_window(app);
    let _ = window.show();
    eprintln!("[appshot-overlay] 起飞 rid={}", req.request_id);
    let app_handle = app.clone();
    let rid = req.request_id;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(HANDOFF_AT_MS));
        // 代次过期说明有新飞行接管，旧 handoff 丢弃。
        if FLY_GENERATION.load(Ordering::SeqCst) == gen {
            emit_handoff(&app_handle, &rid);
        }
        // 不 hide：常驻窗保持显示（防 WKWebView occlusion 暂停 rAF 导致动画跳段），
        // 动画结束 stage 自动清空（shot.remove），无视觉残留。
    });
}

/// 把 overlay 的 NSWindow 抬到 screen-saver 级并允许进入所有 Space + 全屏 Space，
/// 使飞入动画能盖在全屏 app 之上。必须在主线程调用（由 run_on_main_thread 保证）。
#[cfg(target_os = "macos")]
unsafe fn raise_overlay_window_level(ns_window_ptr: *mut std::ffi::c_void) {
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
