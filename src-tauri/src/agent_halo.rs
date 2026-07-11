// Agent Halo — computer-use（CUA 原生驱动）进行时，以透明穿透 overlay 跟随系统指针。
// 窗口在首次使用时创建一次，正常运行周期只 hide/resume，不销毁 WebView。

use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const HALO_LABEL: &str = "agent-halo";
const VISIBLE_POLL_INTERVAL: Duration = Duration::from_millis(16);
const HIDDEN_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HaloMode {
    Active,
    Idle,
}

impl HaloMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "active" => Ok(Self::Active),
            "idle" => Ok(Self::Idle),
            _ => Err(format!("unknown halo mode: {value}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Idle => "idle",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MonitorLayout {
    origin_x: i32,
    origin_y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct DesiredHaloState {
    visible: bool,
    mode: HaloMode,
    layout: Option<MonitorLayout>,
}

impl Default for DesiredHaloState {
    fn default() -> Self {
        Self {
            visible: false,
            mode: HaloMode::Active,
            layout: None,
        }
    }
}

#[derive(Debug)]
enum HaloPhase<W> {
    Absent,
    Loading { generation: u64 },
    Ready { generation: u64, window: W },
}

#[derive(Debug)]
struct HaloLifecycle<W> {
    generation: u64,
    phase: HaloPhase<W>,
    desired: DesiredHaloState,
}

impl<W> Default for HaloLifecycle<W> {
    fn default() -> Self {
        Self {
            generation: 0,
            phase: HaloPhase::Absent,
            desired: DesiredHaloState::default(),
        }
    }
}

#[derive(Debug)]
enum ShowAction<W> {
    Build { generation: u64 },
    Wait,
    Resume { generation: u64, window: W },
}

impl<W: Clone> HaloLifecycle<W> {
    fn request_show(&mut self) -> ShowAction<W> {
        self.desired.visible = true;
        match &self.phase {
            HaloPhase::Absent => {
                self.generation = self
                    .generation
                    .checked_add(1)
                    .expect("agent halo generation overflow");
                self.phase = HaloPhase::Loading {
                    generation: self.generation,
                };
                ShowAction::Build {
                    generation: self.generation,
                }
            }
            HaloPhase::Loading { .. } => ShowAction::Wait,
            HaloPhase::Ready { generation, window } => ShowAction::Resume {
                generation: *generation,
                window: window.clone(),
            },
        }
    }

    fn request_hide(&mut self) {
        self.desired.visible = false;
    }

    fn request_mode(&mut self, mode: HaloMode) {
        self.desired.mode = mode;
    }

    fn complete_loading(&mut self, generation: u64, window: W) -> bool {
        if !matches!(
            self.phase,
            HaloPhase::Loading {
                generation: current
            } if current == generation
        ) {
            return false;
        }
        self.phase = HaloPhase::Ready { generation, window };
        true
    }

    fn fail_loading(&mut self, generation: u64) -> bool {
        if !matches!(
            self.phase,
            HaloPhase::Loading {
                generation: current
            } if current == generation
        ) {
            return false;
        }
        self.phase = HaloPhase::Absent;
        self.desired.layout = None;
        true
    }

    fn is_ready_generation(&self, generation: u64) -> bool {
        matches!(
            self.phase,
            HaloPhase::Ready {
                generation: current,
                ..
            } if current == generation
        )
    }
}

#[derive(Default)]
pub struct AgentHaloState {
    lifecycle: Mutex<HaloLifecycle<WebviewWindow>>,
}

#[derive(Debug, Clone, Copy)]
struct CursorSample {
    layout: MonitorLayout,
    local_x: f64,
    local_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CursorCoordinateSpace {
    MacPrimaryPhysicalizedGlobalLogical,
    WindowsPhysical,
    UnsupportedPhysicalFallback,
}

fn coordinate_space() -> CursorCoordinateSpace {
    #[cfg(target_os = "macos")]
    return CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical;

    #[cfg(target_os = "windows")]
    return CursorCoordinateSpace::WindowsPhysical;

    // Tauri currently exposes physical cursor coordinates on the other desktop backends.
    // Keep the conservative physical-delta fallback explicit so a future backend change is
    // isolated to this pure conversion layer instead of silently corrupting negative origins.
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    CursorCoordinateSpace::UnsupportedPhysicalFallback
}

fn cursor_in_layout(
    cursor_x: f64,
    cursor_y: f64,
    layout: MonitorLayout,
    primary_scale: f64,
    space: CursorCoordinateSpace,
) -> bool {
    let (x, y, origin_x, origin_y, width, height) = match space {
        CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical => (
            cursor_x / primary_scale,
            cursor_y / primary_scale,
            layout.origin_x as f64 / layout.scale,
            layout.origin_y as f64 / layout.scale,
            layout.width as f64 / layout.scale,
            layout.height as f64 / layout.scale,
        ),
        CursorCoordinateSpace::WindowsPhysical
        | CursorCoordinateSpace::UnsupportedPhysicalFallback => (
            cursor_x,
            cursor_y,
            layout.origin_x as f64,
            layout.origin_y as f64,
            layout.width as f64,
            layout.height as f64,
        ),
    };
    x >= origin_x && x < origin_x + width && y >= origin_y && y < origin_y + height
}

fn local_cursor_coordinates(
    cursor_x: f64,
    cursor_y: f64,
    layout: MonitorLayout,
    primary_scale: f64,
    space: CursorCoordinateSpace,
) -> (f64, f64) {
    match space {
        // Tao obtains a global logical macOS point and physicalizes the whole point with the
        // primary monitor scale. Monitor positions, however, are physicalized with each
        // monitor's own scale. Undo those two conversions independently before subtracting.
        CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical => (
            cursor_x / primary_scale - layout.origin_x as f64 / layout.scale,
            cursor_y / primary_scale - layout.origin_y as f64 / layout.scale,
        ),
        CursorCoordinateSpace::WindowsPhysical
        | CursorCoordinateSpace::UnsupportedPhysicalFallback => (
            (cursor_x - layout.origin_x as f64) / layout.scale,
            (cursor_y - layout.origin_y as f64) / layout.scale,
        ),
    }
}

fn resolve_cursor_sample(app: &AppHandle) -> Result<CursorSample, String> {
    let cursor = app
        .cursor_position()
        .map_err(|e| format!("cursor_position: {e}"))?;
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("available_monitors: {e}"))?;
    if monitors.is_empty() {
        return Err("no monitors".into());
    }
    let primary_scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or_else(|| monitors[0].scale_factor());
    let space = coordinate_space();

    let layouts: Vec<MonitorLayout> = monitors
        .iter()
        .map(|monitor| MonitorLayout {
            origin_x: monitor.position().x,
            origin_y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
            scale: monitor.scale_factor(),
        })
        .collect();
    let layout = layouts
        .iter()
        .copied()
        .find(|layout| cursor_in_layout(cursor.x, cursor.y, *layout, primary_scale, space))
        .unwrap_or(layouts[0]);
    let (local_x, local_y) =
        local_cursor_coordinates(cursor.x, cursor.y, layout, primary_scale, space);
    Ok(CursorSample {
        layout,
        local_x,
        local_y,
    })
}

fn set_physical_monitor_bounds(
    window: &WebviewWindow,
    layout: MonitorLayout,
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(layout.origin_x, layout.origin_y))
        .map_err(|e| format!("halo set_position: {e}"))?;
    window
        .set_size(PhysicalSize::new(layout.width, layout.height))
        .map_err(|e| format!("halo set_size: {e}"))
}

fn eval_position(window: &WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    window
        .eval(&format!(
            "window.__haloPos&&window.__haloPos({x:.3},{y:.3})"
        ))
        .map_err(|e| format!("halo position eval: {e}"))
}

fn resume_ready_window(
    state: &AgentHaloState,
    generation: u64,
    window: &WebviewWindow,
    sample: CursorSample,
) -> Result<(), String> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "agent halo state mutex poisoned".to_string())?;
    if !lifecycle.is_ready_generation(generation) || !lifecycle.desired.visible {
        return Ok(());
    }

    if lifecycle.desired.layout != Some(sample.layout) {
        set_physical_monitor_bounds(window, sample.layout)?;
        lifecycle.desired.layout = Some(sample.layout);
    }
    window
        .eval("window.__haloResume&&window.__haloResume()")
        .map_err(|e| format!("halo resume eval: {e}"))?;
    window
        .eval(&format!(
            "window.__haloMode&&window.__haloMode('{}')",
            lifecycle.desired.mode.as_str()
        ))
        .map_err(|e| format!("halo mode eval: {e}"))?;
    // A show always sends the current point, including when it is unchanged from last run.
    eval_position(window, sample.local_x, sample.local_y)?;
    window.show().map_err(|e| format!("halo show: {e}"))
}

fn finish_loading(window: WebviewWindow, generation: u64) -> Result<(), String> {
    let app = window.app_handle().clone();
    let state = app.state::<AgentHaloState>();
    let sample = resolve_cursor_sample(&app)?;
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "agent halo state mutex poisoned".to_string())?;
    if !matches!(
        lifecycle.phase,
        HaloPhase::Loading {
            generation: current
        } if current == generation
    ) {
        return Ok(());
    }

    set_physical_monitor_bounds(&window, sample.layout)?;
    window
        .eval(&format!(
            "window.__haloInit&&window.__haloInit({:.3},{:.3},'{}')",
            sample.local_x,
            sample.local_y,
            lifecycle.desired.mode.as_str()
        ))
        .map_err(|e| format!("halo init eval: {e}"))?;
    lifecycle.desired.layout = Some(sample.layout);
    if !lifecycle.complete_loading(generation, window.clone()) {
        return Ok(());
    }
    if lifecycle.desired.visible {
        // Mode may have changed while the page was loading; apply the latest value before show.
        window
            .eval(&format!(
                "window.__haloMode&&window.__haloMode('{}')",
                lifecycle.desired.mode.as_str()
            ))
            .map_err(|e| format!("halo mode eval: {e}"))?;
        eval_position(&window, sample.local_x, sample.local_y)?;
        window.show().map_err(|e| format!("halo show: {e}"))?;
    }
    drop(lifecycle);

    spawn_cursor_poller(app, window, generation);
    Ok(())
}

fn fail_loading(state: &AgentHaloState, generation: u64) {
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        lifecycle.fail_loading(generation);
    }
}

/// The worker owns the exact WebView handle and generation it was created for. It never looks a
/// window up by label, so a stale worker cannot attach itself to a later generation.
fn spawn_cursor_poller(app: AppHandle, window: WebviewWindow, generation: u64) {
    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        loop {
            let state = app.state::<AgentHaloState>();
            let visible = match state.lifecycle.lock() {
                Ok(lifecycle) if lifecycle.is_ready_generation(generation) => {
                    lifecycle.desired.visible
                }
                _ => break,
            };
            if !visible {
                std::thread::sleep(HIDDEN_POLL_INTERVAL);
                continue;
            }

            if let Ok(sample) = resolve_cursor_sample(&app) {
                let mut lifecycle = match state.lifecycle.lock() {
                    Ok(lifecycle)
                        if lifecycle.is_ready_generation(generation)
                            && lifecycle.desired.visible =>
                    {
                        lifecycle
                    }
                    Ok(_) => {
                        std::thread::sleep(VISIBLE_POLL_INTERVAL);
                        continue;
                    }
                    Err(_) => break,
                };
                let monitor_changed = lifecycle.desired.layout != Some(sample.layout);
                let moved = last
                    .map(|(x, y)| {
                        (x - sample.local_x).abs() > 0.5 || (y - sample.local_y).abs() > 0.5
                    })
                    .unwrap_or(true);

                let transition_result = if monitor_changed {
                    set_physical_monitor_bounds(&window, sample.layout).and_then(|()| {
                        window
                            .eval("window.__haloResume&&window.__haloResume()")
                            .map_err(|e| format!("halo resume eval: {e}"))
                    })
                } else {
                    Ok(())
                };
                if transition_result.is_ok() && (monitor_changed || moved) {
                    // Update `last` only after Ready was rechecked and the eval succeeded.
                    if eval_position(&window, sample.local_x, sample.local_y).is_ok() {
                        lifecycle.desired.layout = Some(sample.layout);
                        last = Some((sample.local_x, sample.local_y));
                    }
                }
            }
            std::thread::sleep(VISIBLE_POLL_INTERVAL);
        }
    });
}

/// 创建并显示光晕 overlay（首次创建隐藏窗口，PageLoadEvent::Finished 后才初始化并显示）。
#[tauri::command]
pub fn agent_halo_show(app: AppHandle, state: State<'_, AgentHaloState>) -> Result<(), String> {
    let action = state
        .lifecycle
        .lock()
        .map_err(|_| "agent halo state mutex poisoned".to_string())?
        .request_show();
    match action {
        ShowAction::Wait => Ok(()),
        ShowAction::Resume { generation, window } => {
            let sample = resolve_cursor_sample(&app)?;
            resume_ready_window(&state, generation, &window, sample)
        }
        ShowAction::Build { generation } => {
            let sample = match resolve_cursor_sample(&app) {
                Ok(sample) => sample,
                Err(error) => {
                    fail_loading(&state, generation);
                    return Err(error);
                }
            };
            let logical_width = sample.layout.width as f64 / sample.layout.scale;
            let logical_height = sample.layout.height as f64 / sample.layout.scale;

            use base64::{engine::general_purpose::STANDARD, Engine as _};
            let data_url = format!(
                "data:text/html;base64,{}",
                STANDARD.encode(HALO_HTML.as_bytes())
            );
            let url: tauri::Url = data_url
                .parse()
                .map_err(|e| format!("halo data url: {e}"))?;
            let build_result =
                WebviewWindowBuilder::new(&app, HALO_LABEL, WebviewUrl::External(url))
                    .inner_size(logical_width, logical_height)
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
                        if payload.event() == PageLoadEvent::Finished {
                            if let Err(error) = finish_loading(window.clone(), generation) {
                                let state = window.app_handle().state::<AgentHaloState>();
                                fail_loading(&state, generation);
                                let _ = window.close();
                                eprintln!("Failed to initialize agent halo: {error}");
                            }
                        }
                    })
                    .build();
            let window = match build_result {
                Ok(window) => window,
                Err(error) => {
                    fail_loading(&state, generation);
                    return Err(format!("halo window build: {error}"));
                }
            };
            let _ = window.set_ignore_cursor_events(true);

            // 抬到 screen-saver 级 + 全 Space，盖过全屏 app。AppKit 调用必须回主线程。
            #[cfg(target_os = "macos")]
            {
                let window_for_level = window.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Ok(ptr) = window_for_level.ns_window() {
                        unsafe { raise_halo_window_level(ptr) };
                    }
                });
            }
            Ok(())
        }
    }
}

/// 切换光晕状态：active（agent 动作在飞）/ idle（用户驱动或空闲，变暗）。
#[tauri::command]
pub fn agent_halo_mode(state: State<'_, AgentHaloState>, mode: String) -> Result<(), String> {
    let mode = HaloMode::parse(&mode)?;
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "agent halo state mutex poisoned".to_string())?;
    lifecycle.request_mode(mode);
    if let HaloPhase::Ready { window, .. } = &lifecycle.phase {
        window
            .eval(&format!(
                "window.__haloMode&&window.__haloMode('{}')",
                mode.as_str()
            ))
            .map_err(|e| format!("halo mode eval: {e}"))?;
    }
    Ok(())
}

/// 隐藏持久 WebView；poller 降频等待，下一次 show 会 resume 并强制推送当前指针。
#[tauri::command]
pub fn agent_halo_hide(state: State<'_, AgentHaloState>) -> Result<(), String> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| "agent halo state mutex poisoned".to_string())?;
    lifecycle.request_hide();
    if let HaloPhase::Ready { window, .. } = &lifecycle.phase {
        window.hide().map_err(|e| format!("halo hide: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe fn raise_halo_window_level(ns_window_ptr: *mut std::ffi::c_void) {
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

// 自包含 overlay 页面：canvas 弹簧光晕。坐标保持 CSS logical pixels；canvas backing
// store 与绘制半径显式乘 DPR，因此不调用 ctx.scale，避免 resize/resume 后重复缩放。
const HALO_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100vw;height:100vh}
canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="c"></canvas><script>
(function(){
  var canvas=document.getElementById('c');
  var ctx=canvas.getContext('2d');
  var dpr=1;
  var target=null;
  var pos=null,vx=0,vy=0;
  var mode='active';
  var opacity=0,opacityTarget=0.9;
  var STIFF=0.16,DAMP=0.72;
  var settledDrawn=false;
  function resize(){
    dpr=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(innerWidth*dpr));
    canvas.height=Math.max(1,Math.round(innerHeight*dpr));
    settledDrawn=false;
  }
  resize();addEventListener('resize',resize);
  window.__haloPos=function(x,y){
    if(target&&Math.abs(target.x-x)<0.5&&Math.abs(target.y-y)<0.5){return;}
    target={x:x,y:y};
    settledDrawn=false;
    if(!pos){pos={x:x,y:y};}
  };
  window.__haloMode=function(m){
    mode=m;
    opacityTarget=m==='active'?0.9:0.32;
    settledDrawn=false;
  };
  window.__haloInit=function(x,y,m){
    resize();
    mode=m;
    opacityTarget=m==='active'?0.9:0.32;
    target={x:x,y:y};pos={x:x,y:y};vx=0;vy=0;
    settledDrawn=false;
  };
  window.__haloResume=function(){
    resize();
    target=null;pos=null;vx=0;vy=0;
    settledDrawn=false;
  };
  function frame(){
    requestAnimationFrame(frame);
    if(!pos||!target){return;}
    var settled=Math.abs(vx)<0.05&&Math.abs(vy)<0.05
      &&Math.abs(target.x-pos.x)<0.1&&Math.abs(target.y-pos.y)<0.1
      &&Math.abs(opacityTarget-opacity)<0.005;
    if(settled&&settledDrawn){return;}
    if(settled){settledDrawn=true;}
    ctx.clearRect(0,0,canvas.width,canvas.height);
    vx=(vx+(target.x-pos.x)*STIFF)*DAMP;
    vy=(vy+(target.y-pos.y)*STIFF)*DAMP;
    pos.x+=vx;pos.y+=vy;
    opacity+=(opacityTarget-opacity)*0.12;
    var r=(mode==='active'?26:20)*dpr;
    var x=pos.x*dpr,y=pos.y*dpr;
    var g=ctx.createRadialGradient(x,y,r*0.15,x,y,r);
    g.addColorStop(0,'rgba(110,231,183,'+(0.55*opacity)+')');
    g.addColorStop(0.55,'rgba(52,211,153,'+(0.3*opacity)+')');
    g.addColorStop(1,'rgba(52,211,153,0)');
    ctx.fillStyle=g;
    ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();
    if(mode==='active'){
      ctx.strokeStyle='rgba(110,231,183,'+(0.5*opacity)+')';
      ctx.lineWidth=1.5*dpr;
      ctx.beginPath();ctx.arc(x,y,r*0.62,0,Math.PI*2);ctx.stroke();
    }
  }
  frame();
})();
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(x: i32, y: i32, width: u32, height: u32, scale: f64) -> MonitorLayout {
        MonitorLayout {
            origin_x: x,
            origin_y: y,
            width,
            height,
            scale,
        }
    }

    fn assert_point(actual: (f64, f64), expected: (f64, f64)) {
        assert!((actual.0 - expected.0).abs() < 0.001, "x: {actual:?}");
        assert!((actual.1 - expected.1).abs() < 0.001, "y: {actual:?}");
    }

    #[test]
    fn single_screen_coordinates_use_monitor_scale() {
        let monitor = layout(0, 0, 2880, 1800, 2.0);
        assert!(cursor_in_layout(
            1000.0,
            800.0,
            monitor,
            2.0,
            CursorCoordinateSpace::WindowsPhysical
        ));
        assert_point(
            local_cursor_coordinates(
                1000.0,
                800.0,
                monitor,
                2.0,
                CursorCoordinateSpace::WindowsPhysical,
            ),
            (500.0, 400.0),
        );
    }

    #[test]
    fn negative_x_and_y_origins_are_preserved() {
        let monitor = layout(-1920, -1080, 1920, 1080, 1.0);
        assert!(cursor_in_layout(
            -1720.0,
            -780.0,
            monitor,
            1.0,
            CursorCoordinateSpace::WindowsPhysical
        ));
        assert_point(
            local_cursor_coordinates(
                -1720.0,
                -780.0,
                monitor,
                1.0,
                CursorCoordinateSpace::WindowsPhysical,
            ),
            (200.0, 300.0),
        );
    }

    #[test]
    fn mac_mixed_two_x_and_one_x_uses_primary_scale_for_cursor_only() {
        let secondary = layout(1440, 0, 1920, 1080, 1.0);
        assert!(cursor_in_layout(
            3200.0,
            600.0,
            secondary,
            2.0,
            CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical
        ));
        assert_point(
            local_cursor_coordinates(
                3200.0,
                600.0,
                secondary,
                2.0,
                CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical,
            ),
            (160.0, 300.0),
        );
    }

    #[test]
    fn monitor_switch_selects_new_bounds_and_local_point() {
        let primary = layout(0, 0, 2880, 1800, 2.0);
        let secondary = layout(1440, 0, 1920, 1080, 1.0);
        let before = (2000.0, 1000.0);
        let after = (3200.0, 600.0);
        assert!(cursor_in_layout(
            before.0,
            before.1,
            primary,
            2.0,
            CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical
        ));
        assert!(!cursor_in_layout(
            after.0,
            after.1,
            primary,
            2.0,
            CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical
        ));
        assert!(cursor_in_layout(
            after.0,
            after.1,
            secondary,
            2.0,
            CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical
        ));
        assert_point(
            local_cursor_coordinates(
                after.0,
                after.1,
                secondary,
                2.0,
                CursorCoordinateSpace::MacPrimaryPhysicalizedGlobalLogical,
            ),
            (160.0, 300.0),
        );
    }

    #[test]
    fn stale_generation_cannot_complete_or_fail_current_load() {
        let mut lifecycle = HaloLifecycle::<()>::default();
        let ShowAction::Build { generation } = lifecycle.request_show() else {
            panic!("first show must build");
        };
        assert!(!lifecycle.complete_loading(generation + 1, ()));
        assert!(!lifecycle.fail_loading(generation + 1));
        assert!(matches!(
            lifecycle.phase,
            HaloPhase::Loading { generation: current } if current == generation
        ));
    }

    #[test]
    fn loading_records_hide_and_mode_before_ready() {
        let mut lifecycle = HaloLifecycle::<()>::default();
        let ShowAction::Build { generation } = lifecycle.request_show() else {
            panic!("first show must build");
        };
        lifecycle.request_hide();
        lifecycle.request_mode(HaloMode::Idle);
        assert!(lifecycle.complete_loading(generation, ()));
        assert!(!lifecycle.desired.visible);
        assert_eq!(lifecycle.desired.mode, HaloMode::Idle);
        assert!(lifecycle.is_ready_generation(generation));
    }

    #[test]
    fn failed_load_retries_with_a_new_monotonic_generation() {
        let mut lifecycle = HaloLifecycle::<()>::default();
        let ShowAction::Build { generation: first } = lifecycle.request_show() else {
            panic!("first show must build");
        };
        assert!(lifecycle.fail_loading(first));
        let ShowAction::Build { generation: second } = lifecycle.request_show() else {
            panic!("retry must build");
        };
        assert!(second > first);
        assert_eq!(second, first + 1);
    }
}
