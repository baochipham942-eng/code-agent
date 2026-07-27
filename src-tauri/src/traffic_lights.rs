// ============================================================================
// traffic_lights - macOS 红绿灯垂直对齐（补 wry 重放通道够不着的那一段）
//
// 原生标题栏已撤（tauri.conf.json titleBarStyle=Overlay + hiddenTitle），三颗系统按钮
// 浮在我们自己画的 h-12 顶行上。系统默认把中心放在距窗口顶 16px，而顶行图标垂直居中后
// 中心在 24px —— 两条顶栏的控件读着不同轴（2026-07-27 产品负责人拍板要同轴）。
//
// 摆位的主力是 `tauri.conf.json` 的 `trafficLightPosition`：它经 wry 落到 WryWebViewParent
// 的 ivar，在那个 view 的 `drawRect:` 里重放 —— 关键是**在那一帧画出来之前**摆，所以窗口
// 缩放 / 双击放大的动画期间不会看见灯抖。（先前把重放挂在 Tauri 的 `Resized` 事件上就会抖：
// 那个事件在该帧已经画完之后才送到，于是每帧都「先按默认位画出来、再被拨回去」。）
//
// 但 wry 那条通道只在**重绘时**生效，而 WKWebView 盖满 parent，窗口静止时它几乎不重绘：
// 主窗口是 `visible:false` → renderer ready 后 `show()`，macOS 在 show 时按默认位重排三颗灯，
// 此后没有重绘、没人补救 ⇒ 灯停在 16。Tauri 2.11 也没有对应的运行时 setter
// （`set_traffic_light_position` 只在 `WebviewWindowBuilder` 上）。
//
// 所以本模块只干一件事：**在 show 之后把 wry 的那套算法原样再跑几遍**，把首帧那一段补上。
// 算法必须与 wry 逐字一致（见下），否则两条通道摆到不同位置，缩放时又会互相拉扯出抖动。
// ============================================================================

/// 与 `tauri.conf.json` 的 `trafficLightPosition` 必须**保持同值**：两条通道跑同一套算法、
/// 喂同一个参数，才不会互相拉扯。改这里就要改那里。
/// 两个值都是**实测反解**出来的，不是推算：
/// - x 是按钮 frame 左缘（不是圆心）。macOS 默认摆在 9，但侧栏内容左轨在 26
///   （见 Sidebar 根的横向节奏注释），灯留在 9 就会孤零零贴着最左、与左下角的账号头像
///   对不上（2026-07-28 产品负责人指出）。所以灯跟着左轨走，取 16；
///   灯间距沿用系统的 23。左轨一改，这里要跟着改。
/// - y 与灯中心是斜率 1 的平移关系：实测 y=22 时中心落在 19.8。目标中心 24
///   （顶行 h-12 ⇒ 图标框中心 24，灯跟着同轴）⇒ 取 26.2。灯圆比 16px 框小一圈，
///   所以它的**可见**上缘会比 16 多约 1.25px，这是圆本身的内缩，不是没对齐。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET: (f64, f64) = (16.0, 26.2);

/// wry `inset_traffic_lights` 的等价实现（wry-0.55.1
/// src/wkwebview/class/wry_web_view_parent.rs）。**刻意逐字照搬**：
/// 容器高度取 `按钮高 + y` 并顶贴窗口顶，按钮只改 x、纵向沿用 AppKit 摆的值。
/// 别"优化"成自己算 origin.y —— 那样与 wry 的 drawRect 重放结果不一致，
/// 缩放时两边各摆各的，就会看见灯上下跳。
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
    let (x, y) = TRAFFIC_LIGHT_INSET;

    // 一颗都取不到 = 窗口还没有标准按钮（非 decorated / 已销毁），静默退出而不是 panic。
    let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(miniaturize) = window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = window.standardWindowButton(NSWindowButton::ZoomButton);

    // 按钮 → NSTitlebarView → NSTitlebarContainerView（与 wry 同一取法）
    let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
        return;
    };

    let close_rect = close.frame();
    let title_bar_frame_height = close_rect.size.height + y;
    let mut title_bar_rect = title_bar_container_view.frame();
    title_bar_rect.size.height = title_bar_frame_height;
    title_bar_rect.origin.y = window.frame().size.height - title_bar_frame_height;
    title_bar_container_view.setFrame(title_bar_rect);

    let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
    let mut buttons = vec![close, miniaturize];
    if let Some(zoom) = zoom {
        buttons.push(zoom);
    }
    for (index, button) in buttons.into_iter().enumerate() {
        let mut rect = button.frame();
        rect.origin.x = x + (index as f64 * space_between);
        button.setFrameOrigin(rect.origin);
    }
}
