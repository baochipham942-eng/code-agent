// ============================================================================
// SwarmInlineMonitor - 停止语义工具（原讨论流浮层壳，N-L6-AGENTVIEW 拆壳）
// ----------------------------------------------------------------------------
// 讨论流浮层已收进右侧「本会话的代理」面板的「事件」折叠区（DiscussionStream
// 直接复用），浮层壳组件删除；本文件只留 cancelSwarmRunOrFallback 导出
// （单测复用停止语义）。
// ============================================================================

import type { SwarmAgentState, SwarmRunRef } from '@shared/contract/swarm';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';

export async function cancelSwarmRunOrFallback(
  scope: SwarmRunRef,
  activeAgents: Array<Pick<SwarmAgentState, 'id'>>,
): Promise<void> {
  const cancelledRun = await ipcService
    .invoke(IPC_CHANNELS.SWARM_CANCEL_RUN, scope)
    .catch(() => false);

  if (cancelledRun) return;

  await Promise.all(
    activeAgents.map((agent) =>
      ipcService.invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { ...scope, agentId: agent.id }).catch(() => {
        // 单个 cancel 失败不阻塞其他 agent，swarm event 会让 UI 自动收敛。
      }),
    ),
  );
}
