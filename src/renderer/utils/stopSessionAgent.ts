// 行级停一位代理：三类各走既有通道——Team 成员 swarm:cancel-agent；普通代理 agent.closeAgent
// （close_agent 工具的 IPC 形态）；后台任务 task.cancelBackgroundTask（TaskManager 既有方法）。
// 「专家」面板的行级停与成员视图顶栏「停掉这位成员」共用这一份（N-SUBAGENT-INPUT）。
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../services/ipcService';

export interface StopSessionAgentTarget {
  kind: 'expert' | 'agent' | 'task';
  key: string;
}

export async function stopSessionAgent(
  target: StopSessionAgentTarget,
  sessionId: string | null,
  runId?: string,
): Promise<void> {
  if (target.kind === 'expert') {
    if (!sessionId || !runId) return;
    await ipcService
      .invoke(IPC_CHANNELS.SWARM_CANCEL_AGENT, { sessionId, runId, agentId: target.key })
      .catch(() => false);
    return;
  }
  if (target.kind === 'agent') {
    await ipcService
      .invokeDomain(IPC_DOMAINS.AGENT, 'closeAgent', { agentId: target.key, sessionId })
      .catch(() => null);
    return;
  }
  await window.domainAPI
    ?.invoke(IPC_DOMAINS.TASK, 'cancelBackgroundTask', { taskId: target.key })
    .catch(() => null);
}
