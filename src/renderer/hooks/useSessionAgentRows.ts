// ============================================================================
// useSessionAgentRows - 「本会话的代理」统一行模型 hook（N-L6-AGENTVIEW）
// ----------------------------------------------------------------------------
// 一根脊柱：useSessionMembers（Team 成员/预选）+ useAgentTreeSnapshot（agentTree
// 快照，含 ownershipConflicts）+ useBackgroundTaskStore（delegate_task 后台任务）。
// 成员条折叠 chip 与右侧「本会话的代理」面板共用这一份，不另起第二份状态。
// ============================================================================

import { useMemo } from 'react';
import type { AgentTreeNode, AgentTreeOwnershipConflict } from '@shared/contract/agentTree';
import { useI18n } from './useI18n';
import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useSessionMembers } from '../components/features/expert/SessionMemberBar';
import { describeLastToolStep } from '../utils/agentActivity';
import { buildAgentRows, type AgentRow } from '../utils/agentRows';

/** parallelCoordinator/agentWorktree 不带会话归属，没锚点（成员/本会话任务）的节点不列，防跨会话泄漏。 */
const UNANCHORED_SOURCES = new Set(['parallelCoordinator', 'agentWorktree']);

function isSessionNode(
  node: AgentTreeNode,
  anchors: ReadonlySet<string>,
): boolean {
  if (anchors.has(node.id)) return true;
  return node.sources.some((source) => !UNANCHORED_SOURCES.has(source));
}

export interface SessionAgentRows {
  rows: AgentRow[];
  conflicts: AgentTreeOwnershipConflict[];
}

export function useSessionAgentRows(sessionId: string | null): SessionAgentRows {
  const { t } = useI18n();
  const members = useSessionMembers(sessionId);
  const { snapshot } = useAgentTreeSnapshot(sessionId);
  const allTasks = useBackgroundTaskStore((state) => state.tasks);

  return useMemo(() => {
    const tasks = sessionId
      ? allTasks.filter((task) => task.sessionId === sessionId)
      : [];
    const anchors = new Set<string>([
      ...members.map((member) => member.key),
      ...tasks.flatMap((task) => {
        const ids = [task.id];
        if (task.runId) ids.push(task.runId);
        const childRunId = task.metadata?.childRunId;
        if (typeof childRunId === 'string') ids.push(childRunId);
        return ids;
      }),
    ]);
    const nodes = (snapshot?.nodes ?? []).filter((node) => isSessionNode(node, anchors));
    const rows = buildAgentRows({
      members,
      nodes,
      tasks,
      describeStep: (step) => describeLastToolStep(step, t),
    });
    return { rows, conflicts: snapshot?.summary.ownershipConflicts ?? [] };
  }, [members, snapshot, allTasks, sessionId, t]);
}
