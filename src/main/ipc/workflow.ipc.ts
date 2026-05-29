// ============================================================================
// Workflow IPC —— dynamic-workflow 进度树事件 + 启动审批推送到渲染进程（P3a + P3b）
// ============================================================================
// 镜像 swarm.ipc 的专用 bridge 模式（不走通用 EventBridge）：scriptRuntime / 审批闸把事件
// publish 到 EventBus 'workflow' domain（bridgeToRenderer:false），本 bridge 订阅后按 type
// 路由投递：
//   - 'launch:*'（审批事件）→ 'workflow:launch:event' 通道（WorkflowLaunchEvent）
//   - 其余（run 事件）→ 'workflow:event' 通道（完整 ScriptRunEvent）
//
// 为什么不用通用 EventBridge：通用 bridge（services/eventing/bridge.ts）只在 Tauri 主进程
// 的 initBackgroundServices 里 start()，webServer 模式根本没起它（与 swarm 同样的坑）。
// 专用 bridge 在模块加载时自装，main/ipc/index.ts 一 import 就生效，Tauri + webServer 两端
// 通吃；webServer 下 webContents.send 被 mock window 拦成 broadcastSSE，自动到浏览器端。
//
// bridgeToRenderer:false 很关键：Tauri 主进程同时跑着通用 EventBridge，若用默认 true 会被
// 通用 bridge 再转发一次 → renderer 收到重复事件。设 false 让本专用 bridge 独家投递。
// ============================================================================

import { BrowserWindow, ipcMain } from '../platform';
import type { ScriptRunEvent, WorkflowLaunchEvent } from '../../shared/contract/scriptRun';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getEventBus } from '../services/eventing/bus';
import { getWorkflowLaunchApprovalGate } from '../agent/workflowLaunchApproval';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('WorkflowIPC');

/** 把 payload 投递到所有渲染进程窗口（web 模式下 webContents.send 被拦成 SSE 广播）。 */
function deliverToRenderers(channel: string, payload: unknown): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

// 模块加载即装桥，幂等。main/ipc/index.ts import 本模块即触发（Tauri + webServer 两端）。
let installed = false;
export function ensureWorkflowBusBridge(): void {
  if (installed) return;
  installed = true;
  // 订阅整个 'workflow' domain，按 BusEvent.type 前缀路由（run 事件 vs launch 审批事件）。
  getEventBus().subscribe('workflow', (evt) => {
    if (typeof evt.type === 'string' && evt.type.startsWith('launch:')) {
      deliverToRenderers(IPC_CHANNELS.WORKFLOW_LAUNCH_EVENT, evt.data as WorkflowLaunchEvent);
    } else {
      deliverToRenderers(IPC_CHANNELS.WORKFLOW_EVENT, evt.data as ScriptRunEvent);
    }
  });
  logger.debug('Workflow EventBus bridge installed');
}

ensureWorkflowBusBridge();

// 审批回传 handler（renderer → main）。幂等，setupAllIpcHandlers 调用（Tauri + webServer 共用 mockIpcMain）。
let handlersRegistered = false;
export function registerWorkflowHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_APPROVE_LAUNCH, async (_event, payload: { requestId: string; feedback?: string }) => {
    return getWorkflowLaunchApprovalGate().approve(payload.requestId, payload.feedback);
  });
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_REJECT_LAUNCH, async (_event, payload: { requestId: string; feedback: string }) => {
    return getWorkflowLaunchApprovalGate().reject(payload.requestId, payload.feedback);
  });
  logger.debug('Workflow approval IPC handlers registered');
}
