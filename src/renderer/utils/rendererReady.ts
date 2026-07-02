import { isTauriMode } from './platform';

/**
 * 桌面壳(Tauri)启动时窗口保持 visible:false,直到 renderer 就绪再显示,避免
 * "深色底→空白→内容"的启动闪烁。
 *
 * 主通道是 invoke command(renderer_ready):emit 事件通道在打包态实测投递不到
 * 壳侧(Rust window.once/app.once 均收不到,窗口只能死等超时兜底),invoke 是
 * 直连调用不走事件路由。emit 保留为兜底副通道,壳侧 AtomicBool 去重,双发无害。
 *
 * 刻意不依赖 requestAnimationFrame:窗口 visible:false 时 WKWebView 的 rAF 被
 * 暂停,信号会永不发出。壳侧另有超时兜底,信号丢失也不会让窗口永久隐藏。
 */
let signaled = false;

/**
 * 就绪信号在"首帧 commit"之外还要等初始会话数据落定(见 App.tsx 的
 * whenInitialSessionStateSettled race),此常量是那次等待的上限:数据层异常时
 * 最多再等这么久就显示窗口,宁可露出加载中也不许窗口迟迟不出现。
 */
export const RENDERER_READY_SETTLE_CAP_MS = 2500;

/** 通知桌面壳 renderer 已就绪(可显示窗口)。幂等;非 Tauri 环境为 no-op。 */
export async function signalRendererReady(): Promise<void> {
  if (signaled || !isTauriMode()) return;
  signaled = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('renderer_ready');
    return;
  } catch {
    // command 不可用(旧壳/桥异常):回退事件通道
  }
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('renderer-ready');
  } catch {
    // 非 Tauri / bridge 不可用:忽略,壳侧超时兜底会显示窗口
  }
}
