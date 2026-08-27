// ============================================================================
// agentRows - 「本会话的代理」统一行模型（N-L6-AGENTVIEW）
// ----------------------------------------------------------------------------
// 一根脊柱的三个既有来源在这里并成一张行表：
//   1) Team 成员（useSessionMembers 的 MemberPill，含 standby 预选）
//   2) agentTree 快照节点（spawn/parallel/后台代理）
//   3) delegate_task 后台任务（backgroundTaskStore 的 Task）
// 九态→四态映射只有 agentRowStatus 一处；去重规则只有 buildAgentRows 一处。
// 枚举值绝不直接铺给用户——用户只看到 工作中/完成/失败/卡住了/待命。
// ============================================================================

import type { AgentTreeNode, AgentTreeNodeStatus } from '@shared/contract/agentTree';
import type { LastToolStep, Task, TaskStatus } from '@shared/contract/backgroundTask';

/** 用户可见四态 + 待命（预选名单）。 */
export type AgentRowStatus = 'working' | 'done' | 'failed' | 'cancelled' | 'waiting' | 'standby';

type AgentRowKind = 'expert' | 'agent' | 'task';

/** Team 成员入参的最小结构（MemberPill 天然满足；这里结构化解耦，避免 utils → 组件反向依赖）。 */
export interface MemberRowSource {
  key: string;
  roleId: string;
  name: string;
  profession?: string;
  icon?: string;
  status: 'standby' | 'running' | 'completed' | 'failed' | 'cancelled';
  isLead: boolean;
  standbyKey?: string;
}

export interface AgentRow {
  key: string;
  kind: AgentRowKind;
  roleId?: string;
  name: string;
  profession?: string;
  icon?: string;
  isLead: boolean;
  status: AgentRowStatus;
  /** 当前一句（最近工具步人话）；没有真实工具步时缺省。 */
  activity?: string;
  failureReason?: string;
  stoppable: boolean;
  tokens?: number;
  /** 原始引用：成员视图 / 行级停 / 头像用。 */
  member?: MemberRowSource;
  node?: AgentTreeNode;
  task?: Task;
}

/**
 * 九态→四态全表（agentTree 10 态 + 后台任务 10 态，有重叠）。
 * 改这张表就是改用户看到的口径，别在组件里另写映射。
 *   working：还在干活（含排队/暂停/状态不明——宁可说在干，别说死）
 *   waiting：卡住了在等人（waiting_input/stalled/blocked）
 *   done：正常完成
 *   cancelled：被用户或父任务停掉
 *   failed：失败/被强杀/只剩日志/过期/孤儿
 */
const AGENT_ROW_STATUS_TABLE: Record<string, AgentRowStatus> = {
  queued: 'working',
  running: 'working',
  'running-recovered': 'working',
  paused: 'working',
  unknown: 'working',
  waiting_input: 'waiting',
  stalled: 'waiting',
  blocked: 'waiting',
  completed: 'done',
  cancelled: 'cancelled',
  failed: 'failed',
  killed: 'failed',
  'dead-log-only': 'failed',
  expired: 'failed',
  orphaned: 'failed',
};

function agentRowStatus(status: AgentTreeNodeStatus | TaskStatus | string): AgentRowStatus {
  return AGENT_ROW_STATUS_TABLE[status] ?? 'working';
}

function memberRowStatus(status: MemberRowSource['status']): AgentRowStatus {
  if (status === 'standby') return 'standby';
  return agentRowStatus(status);
}

/** delegate_task 后台任务与 agentTree 节点的关联键：id / runId / metadata.childRunId 任一相等即同一个代理。 */
function taskLinkedNodeId(task: Task, nodeIds: ReadonlySet<string>): string | undefined {
  if (nodeIds.has(task.id)) return task.id;
  if (task.runId && nodeIds.has(task.runId)) return task.runId;
  const childRunId = task.metadata?.childRunId;
  if (typeof childRunId === 'string' && nodeIds.has(childRunId)) return childRunId;
  return undefined;
}

export function buildAgentRows(input: {
  members: MemberRowSource[];
  nodes: AgentTreeNode[];
  tasks: Task[];
  describeStep: (step: LastToolStep | undefined) => string | undefined;
}): AgentRow[] {
  const { members, nodes, tasks, describeStep } = input;
  const rows: AgentRow[] = [];
  const memberKeys = new Set(members.map((member) => member.key));

  for (const member of members) {
    rows.push({
      key: member.key,
      kind: 'expert',
      roleId: member.roleId,
      name: member.name,
      profession: member.profession,
      icon: member.icon,
      isLead: member.isLead,
      status: memberRowStatus(member.status),
      // 没有真实工具步就不声称正在做事；若 agentTree 里有同名节点，下面会把
      // 它真实的最近工具步补上来。
      activity: undefined,
      stoppable: member.status === 'running',
      member,
    });
  }

  const nodeIds = new Set<string>();
  for (const node of nodes) {
    // Team 成员同时出现在 spawnGuard/parallelCoordinator 里：专家行已经代表他，不重复列；
    // 但节点上的最近工具步/预算是真数据，并回专家行
    if (memberKeys.has(node.id)) {
      const row = rows.find((candidate) => candidate.key === node.id);
      if (row) {
        row.node = node;
        if (node.lastToolStep) row.activity = describeStep(node.lastToolStep);
        if (typeof node.budgetSummary.tokensUsed === 'number') row.tokens = node.budgetSummary.tokensUsed;
        if (node.failureReason) row.failureReason = node.failureReason;
      }
      continue;
    }
    nodeIds.add(node.id);
    const status = agentRowStatus(node.status);
    rows.push({
      key: node.id,
      kind: 'agent',
      roleId: node.role,
      name: node.role,
      isLead: false,
      status,
      activity: describeStep(node.lastToolStep),
      failureReason: node.failureReason,
      stoppable: status === 'working',
      tokens: node.budgetSummary.tokensUsed,
      node,
    });
  }

  for (const task of tasks) {
    const status = agentRowStatus(task.status);
    const linkedNodeId = taskLinkedNodeId(task, nodeIds);
    if (linkedNodeId) {
      // 同一个代理在 agentTree 与 Task 两边都有：只留节点行，把 Task 挂上去供成员视图取产出
      const row = rows.find((candidate) => candidate.key === linkedNodeId);
      if (row) row.task = task;
      continue;
    }
    rows.push({
      key: task.id,
      kind: 'task',
      name: task.title,
      isLead: false,
      status,
      activity: describeStep(task.progress?.lastToolStep),
      failureReason: task.failure?.message,
      stoppable: status === 'working',
      task,
    });
  }

  return rows;
}
