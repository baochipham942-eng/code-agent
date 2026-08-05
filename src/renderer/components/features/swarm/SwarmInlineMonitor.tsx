// ============================================================================
// SwarmInlineMonitor - 讨论流浮层壳（施工单二 A3）
// ============================================================================
// 成员列表已收敛到 SessionMemberBar；停止全部 / totalTokens 也迁到成员条。
// 本组件只保留 DiscussionStream 挂载壳 + cancelSwarmRunOrFallback 导出
// （成员条与单测复用停止语义）。
// ============================================================================

import type { SwarmAgentState, SwarmRunRef } from '@shared/contract/swarm';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { useSwarmStore } from '../../../stores/swarmStore';
import { DiscussionStream } from './DiscussionStream';

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

export function SwarmInlineMonitor() {
  const eventLogLength = useSwarmStore((s) => (s.eventLog ?? []).length);
  if (eventLogLength === 0) return null;

  return (
    <div className="w-full shrink-0 chat-col-pad">
      <div className="mx-auto max-w-3xl rounded-lg border border-zinc-700/70 bg-zinc-900/95 backdrop-blur-sm shadow-xl text-xs">
        <DiscussionStream />
      </div>
    </div>
  );
}
