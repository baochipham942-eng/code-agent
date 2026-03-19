// ============================================================================
// Active Agent Context - 注入当前运行中的子代理信息
// ============================================================================
//
// 借鉴 Codex CLI 的 <environment_context> 模式：
// 让主 Agent 感知当前活跃的子代理，避免重复 spawn 或等待已完成的 agent。
// ============================================================================

import { getSpawnGuard } from './spawnGuard';

/**
 * 构建活跃子代理的上下文块。
 * 如果没有活跃 agent，返回空字符串（不占用 token）。
 */
export function buildActiveAgentContext(): string {
  const guard = getSpawnGuard();
  const agents = guard.list();

  if (agents.length === 0) return '';

  const lines: string[] = [];

  for (const agent of agents) {
    const duration = agent.completedAt
      ? `${Math.round((agent.completedAt - agent.createdAt) / 1000)}s`
      : `${Math.round((Date.now() - agent.createdAt) / 1000)}s`;

    const taskPreview = agent.task.length > 60
      ? agent.task.slice(0, 60) + '...'
      : agent.task;

    const icon = {
      running: '⏳',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
    }[agent.status];

    lines.push(`- ${icon} ${agent.id}: ${agent.role} (${agent.status}, ${duration}) — "${taskPreview}"`);
  }

  const running = agents.filter(a => a.status === 'running').length;
  const total = agents.length;

  return `\n<active_subagents>
${running} running, ${total} total
${lines.join('\n')}
</active_subagents>`;
}

/**
 * Drain pending completion notifications from SpawnGuard.
 * Called by contextAssembly each inference turn to inform parent agent
 * about background agents that finished since last turn (Codex-style async notifications).
 */
export function drainCompletionNotifications(): string[] {
  return getSpawnGuard().drainNotifications();
}
