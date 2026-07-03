// ============================================================================
// agentRegistrySSEBridge —— agents:changed 在 web 生产模式的 SSE 桥（S4）
// ----------------------------------------------------------------------------
// agentRegistry.ipc.ts 的广播依赖 BrowserWindow.getAllWindows()，web 模式
// （electronMock）恒返回 [] → 广播 no-op，renderer 的 agent registry 停留在
// 启动快照。webServer 启动时调用本桥，把 registry 变更直接 broadcastSSE 给
// 全部 SSE 客户端（httpTransport 按 channel 分发到 agentRegistryStore 订阅）。
// ============================================================================

import { onAgentRegistryChange, listAllAgentsWithRoleFlag } from './agentRegistry';
import { IPC_CHANNELS } from '../../shared/ipc';

export function bridgeAgentRegistryChangesToSSE(
  broadcast: (channel: string, data: unknown) => void,
): () => void {
  return onAgentRegistryChange(() => {
    void (async () => {
      try {
        const agents = await listAllAgentsWithRoleFlag();
        broadcast(IPC_CHANNELS.AGENTS_CHANGED, { agents });
      } catch {
        // 列表读取失败：跳过本次推送，下次变更重试（非致命）
      }
    })();
  });
}
