import { isTauriMode } from './platform';

/**
 * 桌面壳(Tauri)启动时窗口保持 visible:false,直到 renderer 完成首次渲染 commit
 * 再发出 renderer-ready 事件,壳侧收到才 window.show()。这样避免"navigate 一开始就
 * 显示、此时首帧还没画出"导致的深色底→空白→内容的启动闪烁(实测闪 2 下)。
 *
 * 刻意不依赖 requestAnimationFrame:窗口 visible:false 时 WKWebView 的 rAF 可能被
 * 节流/暂停,导致信号永不发出。改为 React 首次 commit 后的 effect 调用,时序可靠;
 * 壳侧另有超时兜底,信号丢失也不会让窗口永久隐藏。
 */
let signaled = false;

/** 通知桌面壳 renderer 已就绪(可显示窗口)。幂等;非 Tauri 环境为 no-op。 */
export async function signalRendererReady(): Promise<void> {
  if (signaled || !isTauriMode()) return;
  signaled = true;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('renderer-ready');
  } catch {
    // 非 Tauri / bridge 不可用:忽略,壳侧超时兜底会显示窗口
  }
}
