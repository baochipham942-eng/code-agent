// ============================================================================
// Workflow IPC —— dynamic-workflow 进度树事件推送到渲染进程（P3a）
// ============================================================================
// 镜像 swarm.ipc 的专用 bridge 模式（不走通用 EventBridge）：scriptRuntime 经
// workflow.ts 把 ScriptRunEvent publish 到 EventBus 'workflow' domain（bridgeToRenderer:
// false），本 bridge 订阅后投递到所有 BrowserWindow 的 'workflow:event' channel。
//
// 为什么不用通用 EventBridge：通用 bridge（services/eventing/bridge.ts）只在 Tauri 主进程
// 的 initBackgroundServices 里 start()，webServer 模式根本没起它（与 swarm 同样的坑）。
// 专用 bridge 在模块加载时自装，main/ipc/index.ts 一 import 就生效，Tauri + webServer 两端
// 通吃；webServer 下 webContents.send 被 mock window 拦成 broadcastSSE，自动到浏览器端。
//
// bridgeToRenderer:false 很关键：Tauri 主进程同时跑着通用 EventBridge，若用默认 true 会被
// 通用 bridge 再转发一次 → renderer 收到重复事件。设 false 让本专用 bridge 独家投递。
// ============================================================================

import { BrowserWindow } from '../platform';
import type { ScriptRunEvent } from '../../shared/contract/scriptRun';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getEventBus } from '../services/eventing/bus';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('WorkflowIPC');

/** 把 ScriptRunEvent 投递到所有渲染进程窗口（web 模式下 webContents.send 被拦成 SSE 广播）。 */
function deliverWorkflowEvent(event: ScriptRunEvent): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.WORKFLOW_EVENT, event);
    }
  }
}

// 模块加载即装桥，幂等。main/ipc/index.ts import 本模块即触发（Tauri + webServer 两端）。
let installed = false;
export function ensureWorkflowBusBridge(): void {
  if (installed) return;
  installed = true;
  getEventBus().subscribe<ScriptRunEvent>('workflow', (evt) => {
    deliverWorkflowEvent(evt.data);
  });
  logger.debug('Workflow EventBus bridge installed');
}

ensureWorkflowBusBridge();
