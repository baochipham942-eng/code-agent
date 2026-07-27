// ============================================================================
// traffic_lights - macOS 红绿灯垂直对齐
//
// 原生标题栏已撤（tauri.conf.json titleBarStyle=Overlay + hiddenTitle），三颗系统按钮
// 浮在我们自己画的 h-12 顶行上。系统默认把它们的中心放在距窗口顶 16px，而顶行图标
// 垂直居中后中心在 24px —— 差 8px，两条顶栏的控件读着不同轴（2026-07-27 产品负责人拍板要同轴）。
//
// 为什么不用 tauri.conf.json 的 trafficLightPosition：它经 wry 落到 WryWebViewParent 的
// ivar，只在那个 parent view 的 `drawRect:` 里重放。WKWebView 盖满 parent，parent 实际
// 几乎不重绘 ⇒ 主窗口 `visible:false` → renderer ready 后 `show()`，macOS 在 show 时按默认位
// 重排三颗灯，配置就此被抹掉且再没人重放。Tauri 2.11 也没有对应的运行时 setter
// （`set_traffic_light_position` 只在 `WebviewWindowBuilder` 上）。所以自己搬。
//
// 摆法是**幂等的绝对定位**，不是相对偏移：容器高度与按钮 origin 都由目标中心值直接算出，
// 重复调用结果不变 —— show / resize 后无脑重放即可，不会越挪越低。
// ============================================================================

/// 三颗灯的中心距窗口顶的目标值（px）。与侧栏顶行 h-12 内垂直居中的图标同轴（中心 24）。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_CENTER_FROM_TOP: f64 = 24.0;

/// 把三颗标准窗口按钮摆到 `TRAFFIC_LIGHT_CENTER_FROM_TOP`。只动纵向，横向保持系统原值
/// （水平位已按 Codex 对过：灯右缘 → 第一颗图标 20px ⇒ 侧栏 `pl-[84px]`）。
///
/// # Safety
/// `ns_window_ptr` 必须是有效的 `NSWindow`，且必须在主线程调用。
#[cfg(target_os = "macos")]
pub unsafe fn align_traffic_lights(ns_window_ptr: *mut std::ffi::c_void) {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    if ns_window_ptr.is_null() {
        return;
    }
    let window: &NSWindow = &*(ns_window_ptr as *const NSWindow);

    let buttons: Vec<_> = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| window.standardWindowButton(kind))
    .collect();

    // 一颗都取不到 = 窗口还没有标准按钮（非 decorated / 已销毁），静默退出而不是 panic。
    let Some(close) = buttons.first() else {
        return;
    };
    let button_height = close.frame().size.height;

    // 按钮 → NSThemeFrame 下的 NSTitlebarView → NSTitlebarContainerView（与 wry 同一取法）。
    let Some(container) = close.superview().and_then(|view| view.superview()) else {
        return;
    };

    // 容器顶贴窗口顶，高度取到「按钮底边正好落在容器底边」：
    // 高 = 目标中心 + 半个按钮 ⇒ 按钮 origin.y = 0，不依赖 AppKit 之前摆的纵向值。
    let mut container_frame = container.frame();
    container_frame.size.height = TRAFFIC_LIGHT_CENTER_FROM_TOP + button_height / 2.0;
    container_frame.origin.y = window.frame().size.height - container_frame.size.height;
    container.setFrame(container_frame);

    for button in &buttons {
        let mut frame = button.frame();
        frame.origin.y = 0.0;
        button.setFrameOrigin(frame.origin);
    }
}
