// Agent Halo — computer-use（CUA 原生驱动）进行时，铺一张全屏透明穿透 overlay，
// 用弹簧拖尾光晕跟随系统指针（单指针 + 共驾聚光灯，borrow 自 Codex 桌面端）。
// agent 驱动与用户驱动共用同一物理指针，光晕一律跟随；驾驶方区分靠 mode：
// active（agent 动作在飞，亮实）/ idle（无动作或用户驱动，暗虚）。
//
// 复用 pip.rs / appshots.rs 的窗口范式：data-url HTML + eval 注入（不依赖 withGlobalTauri），
// 透明 + ignore_cursor_events + macOS screen-saver 层级；光标位置由 Rust 线程 ~60Hz
// 轮询 cursor_position() 后 eval 推给 overlay，弹簧插值在 canvas rAF 里做。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const HALO_LABEL: &str = "agent-halo";
const POLL_INTERVAL_MS: u64 = 16;

static POLLER_RUNNING: AtomicBool = AtomicBool::new(false);

/// 全部显示器的逻辑坐标 union（origin_x, origin_y, width, height, scale）。
/// ponytail: 混合 DPI 多屏统一用主屏 scale（与 appshots overlay 同口径），极端混搭屏待反馈再修。
fn virtual_screen_bounds(app: &AppHandle) -> Result<(f64, f64, f64, f64, f64), String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("available_monitors: {e}"))?;
    if monitors.is_empty() {
        return Err("no monitors".into());
    }
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
    Ok((
        min_x as f64 / scale,
        min_y as f64 / scale,
        (max_x - min_x) as f64 / scale,
        (max_y - min_y) as f64 / scale,
        scale,
    ))
}

/// 轮询系统指针位置推给 overlay。窗口关闭后自动退出。
fn ensure_cursor_poller(app: &AppHandle, origin_x: f64, origin_y: f64, scale: f64) {
    if POLLER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<(f64, f64)> = None;
        loop {
            let Some(window) = app.get_webview_window(HALO_LABEL) else {
                break;
            };
            if let Ok(pos) = app.cursor_position() {
                let x = pos.x / scale - origin_x;
                let y = pos.y / scale - origin_y;
                let moved = last
                    .map(|(lx, ly)| (lx - x).abs() > 0.5 || (ly - y).abs() > 0.5)
                    .unwrap_or(true);
                if moved {
                    last = Some((x, y));
                    let _ = window.eval(&format!(
                        "window.__haloPos && window.__haloPos({x:.1},{y:.1})"
                    ));
                }
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
        POLLER_RUNNING.store(false, Ordering::SeqCst);
    });
}

/// 创建并显示光晕 overlay（幂等：已存在则只 show）。
#[tauri::command]
pub fn agent_halo_show(app: AppHandle) -> Result<(), String> {
    let (origin_x, origin_y, win_w, win_h, scale) = virtual_screen_bounds(&app)?;

    if let Some(w) = app.get_webview_window(HALO_LABEL) {
        let _ = w.show();
        ensure_cursor_poller(&app, origin_x, origin_y, scale);
        return Ok(());
    }

    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let data_url = format!(
        "data:text/html;base64,{}",
        STANDARD.encode(HALO_HTML.as_bytes())
    );
    let url: tauri::Url = data_url
        .parse()
        .map_err(|e| format!("halo data url: {e}"))?;

    let window = WebviewWindowBuilder::new(&app, HALO_LABEL, WebviewUrl::External(url))
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
        .build()
        .map_err(|e| format!("halo window build: {e}"))?;

    let _ = window.set_ignore_cursor_events(true);

    // 抬到 screen-saver 级 + 全 Space，盖过全屏 app。AppKit 调用必须回主线程。
    #[cfg(target_os = "macos")]
    {
        let app_for_level = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app_for_level.get_webview_window(HALO_LABEL) {
                if let Ok(ptr) = w.ns_window() {
                    unsafe { raise_halo_window_level(ptr) };
                }
            }
        });
    }

    ensure_cursor_poller(&app, origin_x, origin_y, scale);
    Ok(())
}

/// 切换光晕状态：active（agent 动作在飞）/ idle（用户驱动或空闲，变暗）。
#[tauri::command]
pub fn agent_halo_mode(app: AppHandle, mode: String) -> Result<(), String> {
    if mode != "active" && mode != "idle" {
        return Err(format!("unknown halo mode: {mode}"));
    }
    if let Some(w) = app.get_webview_window(HALO_LABEL) {
        let _ = w.eval(&format!("window.__haloMode && window.__haloMode('{mode}')"));
    }
    Ok(())
}

/// 关闭光晕 overlay（轮询线程随窗口消失自动退出）。
#[tauri::command]
pub fn agent_halo_hide(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(HALO_LABEL) {
        let _ = w.close();
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

// 自包含 overlay 页面：canvas 弹簧光晕。__haloPos 更新目标点，__haloMode 切亮暗。
// 色板对齐 AgentPointerOverlay 的 computer tone（emerald）。
const HALO_HTML: &str = r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;width:100vw;height:100vh}
canvas{display:block;width:100vw;height:100vh}
</style></head><body><canvas id="c"></canvas><script>
(function(){
  var canvas=document.getElementById('c');
  var ctx=canvas.getContext('2d');
  var dpr=window.devicePixelRatio||1;
  function resize(){canvas.width=innerWidth*dpr;canvas.height=innerHeight*dpr;}
  resize();addEventListener('resize',resize);
  var target=null;
  var pos=null,vx=0,vy=0;
  var mode='active';
  var opacity=0,opacityTarget=0.9;
  var STIFF=0.16,DAMP=0.72;
  var settledDrawn=false;
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
