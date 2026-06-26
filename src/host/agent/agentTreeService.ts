import {
  AgentFailureCode,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import type {
  AgentTreeBudgetSummary,
  AgentTreeEventSummary,
  AgentTreeNode,
  AgentTreeNodeSource,
  AgentTreeNodeStatus,
  AgentTreeSnapshot,
  AgentWorktreeArtifact,
  AgentTreeWorktreeState,
} from '../../shared/contract/agentTree';
import type { EvidenceRef } from '../../shared/contract/evidence';
import type { ManagedAgentStatus } from './spawnGuard';
import { getSpawnGuard } from './spawnGuard';
import {
  getParallelAgentCoordinator,
  type AgentTaskResult,
  type ParallelAgentTaskSnapshot,
  type ParallelAgentTaskSnapshotStatus,
} from './parallelAgentCoordinator';
import {
  getBackgroundSubagentRegistry,
  type BackgroundSubagentHandle,
} from './backgroundSubagentRegistry';
import {
  getSubagentContextStore,
  type SubagentContextRecord,
} from '../context/subagentContextStore';
import type { SubagentResult } from './subagentExecutorTypes';
import { listAgentWorktreeArtifacts } from './agentWorktree';

export interface AgentTreeSpawnAgentSource {
  id: string;
  role: string;
  treeId?: string;
  parentId?: string;
  status: ManagedAgentStatus;
  task: string;
  result?: SubagentResult;
  error?: string;
  createdAt?: number;
  completedAt?: number;
}

export interface AgentTreeSnapshotSources {
  sessionId?: string;
  now?: number;
  spawnAgents?: AgentTreeSpawnAgentSource[];
  parallelTasks?: ParallelAgentTaskSnapshot[];
  contextRecords?: SubagentContextRecord[];
  backgroundAgents?: BackgroundSubagentHandle[];
  worktrees?: AgentWorktreeArtifact[];
}

export interface GetAgentTreeSnapshotOptions {
  sessionId?: string;
  now?: number;
  worktrees?: AgentWorktreeArtifact[];
}

const STATUS_PRIORITY: Record<AgentTreeNodeSource, number> = {
  agentWorktree: 10,
  subagentContext: 20,
  backgroundRegistry: 50,
  parallelCoordinator: 60,
  spawnGuard: 100,
};

function defaultWorktreeState(): AgentTreeWorktreeState {
  return { status: 'none' };
}

function statusLabel(status: AgentTreeNodeStatus): string {
  switch (status) {
    case 'queued':
      return '等待开始';
    case 'running':
    case 'running-recovered':
      return '正在处理';
    case 'dead-log-only':
      return '只剩日志记录';
    case 'completed':
      return '已完成';
    case 'failed':
      return '遇到问题';
    case 'cancelled':
      return '已取消';
    case 'killed':
      return '已强制结束';
    case 'blocked':
      return '被前置条件卡住';
    case 'unknown':
    default:
      return '状态待确认';
  }
}

function failureReason(code: AgentFailureCode): string {
  switch (code) {
    case AgentFailureCode.BlockedByParentRole:
      return '上级角色规则不允许它继续';
    case AgentFailureCode.PermissionDenied:
      return '需要的权限没有通过';
    case AgentFailureCode.ToolUnavailable:
      return '需要的能力当前不可用';
    case AgentFailureCode.BudgetExhausted:
      return '可用预算已经用完';
    case AgentFailureCode.Timeout:
      return '处理时间超过了限制';
    case AgentFailureCode.ParentGone:
      return '父任务已经结束';
    case AgentFailureCode.CancelledByUser:
      return '用户取消了这个任务';
    case AgentFailureCode.CancelledByParent:
      return '父任务取消了这个任务';
    case AgentFailureCode.DependencyFailed:
      return '依赖的任务失败了';
    case AgentFailureCode.DependencyMissing:
      return '依赖的任务不存在';
    case AgentFailureCode.WorkflowStageFailed:
      return '工作流中的一个阶段失败了';
    case AgentFailureCode.WorktreeCreateFailed:
      return '无法创建隔离工作区';
    case AgentFailureCode.ModelError:
      return '模型调用没有成功完成';
    case AgentFailureCode.Unknown:
    default:
      return '失败原因还不明确';
  }
}

function truncate(value: string | undefined, maxLength = 220): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function makeNode(id: string, role = 'agent'): AgentTreeNode {
  return {
    id,
    role,
    status: 'unknown',
    statusLabel: statusLabel('unknown'),
    children: [],
    worktreeState: defaultWorktreeState(),
    budgetSummary: {},
    evidenceRefs: [],
    sources: [],
  };
}

function ensureNode(nodes: Map<string, AgentTreeNode>, id: string, role?: string): AgentTreeNode {
  const existing = nodes.get(id);
  if (existing) {
    if (role && existing.role === 'agent') existing.role = role;
    return existing;
  }
  const node = makeNode(id, role);
  nodes.set(id, node);
  return node;
}

function addSource(node: AgentTreeNode, source: AgentTreeNodeSource): void {
  if (!node.sources.includes(source)) node.sources.push(source);
}

function applyStatus(
  node: AgentTreeNode,
  status: AgentTreeNodeStatus,
  source: AgentTreeNodeSource,
  statusPriorities: Map<string, number>,
): void {
  const priority = STATUS_PRIORITY[source];
  const currentPriority = statusPriorities.get(node.id) ?? -1;
  if (priority >= currentPriority) {
    node.status = status;
    node.statusLabel = statusLabel(status);
    statusPriorities.set(node.id, priority);
  }
}

function applyFailure(node: AgentTreeNode, code?: AgentFailureCode): void {
  if (!code) return;
  node.failureCode = code;
  node.failureReason = failureReason(code);
}

function setLastEvent(node: AgentTreeNode, event: AgentTreeEventSummary): void {
  const currentAt = node.lastEvent?.at ?? 0;
  const nextAt = event.at ?? currentAt;
  if (!node.lastEvent || nextAt >= currentAt) {
    node.lastEvent = event;
  }
}

function mergeBudget(
  target: AgentTreeBudgetSummary,
  source: AgentTreeBudgetSummary,
): AgentTreeBudgetSummary {
  const merged: AgentTreeBudgetSummary = { ...target };
  if (typeof source.costUsd === 'number') merged.costUsd = source.costUsd;
  if (typeof source.tokensUsed === 'number') merged.tokensUsed = source.tokensUsed;
  if (typeof source.maxTokens === 'number') merged.maxTokens = source.maxTokens;
  if (typeof source.usagePercent === 'number') merged.usagePercent = source.usagePercent;
  if (typeof source.iterations === 'number') merged.iterations = source.iterations;
  if (typeof source.toolCalls === 'number') merged.toolCalls = source.toolCalls;
  return merged;
}

function budgetFromResult(result?: SubagentResult | AgentTaskResult): AgentTreeBudgetSummary {
  if (!result) return {};
  return {
    ...(typeof result.cost === 'number' ? { costUsd: result.cost } : {}),
    ...(typeof result.tokensUsed === 'number' ? { tokensUsed: result.tokensUsed } : {}),
    ...(typeof result.iterations === 'number' ? { iterations: result.iterations } : {}),
    ...(Array.isArray(result.toolsUsed) ? { toolCalls: result.toolsUsed.length } : {}),
  };
}

function budgetFromContext(record: SubagentContextRecord): AgentTreeBudgetSummary {
  const snapshot = record.snapshot;
  if (!snapshot) return {};
  return {
    ...(typeof snapshot.currentTokens === 'number' ? { tokensUsed: snapshot.currentTokens } : {}),
    ...(typeof snapshot.maxTokens === 'number' ? { maxTokens: snapshot.maxTokens } : {}),
    ...(typeof snapshot.usagePercent === 'number' ? { usagePercent: snapshot.usagePercent } : {}),
  };
}

function managedStatusToTree(status: ManagedAgentStatus): AgentTreeNodeStatus {
  return status;
}

function parallelStatusToTree(status: ParallelAgentTaskSnapshotStatus): AgentTreeNodeStatus {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    default:
      return 'unknown';
  }
}

function backgroundStatusToTree(status: BackgroundSubagentHandle['status']): AgentTreeNodeStatus {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function activeToolFromContext(record: SubagentContextRecord): string | undefined {
  const tools = record.snapshot?.tools;
  return tools && tools.length > 0 ? tools[tools.length - 1] : undefined;
}

function progressFromContext(record: SubagentContextRecord): string | undefined {
  const previews = record.snapshot?.previews;
  if (previews && previews.length > 0) {
    return truncate(previews[previews.length - 1]?.contentPreview);
  }
  const lastMessage = record.messages[record.messages.length - 1];
  return truncate(typeof lastMessage?.content === 'string' ? lastMessage.content : undefined);
}

function resultProgress(result?: SubagentResult | AgentTaskResult): string | undefined {
  return truncate(result?.success ? result.output : result?.error);
}

function addEvidenceRefs(node: AgentTreeNode, refs?: EvidenceRef[]): void {
  if (!refs || refs.length === 0) return;
  const known = new Set(node.evidenceRefs.map((ref) => ref.id));
  for (const ref of refs) {
    if (known.has(ref.id)) continue;
    node.evidenceRefs.push(ref);
    known.add(ref.id);
  }
}

function mergeSpawnAgent(
  nodes: Map<string, AgentTreeNode>,
  statusPriorities: Map<string, number>,
  agent: AgentTreeSpawnAgentSource,
): void {
  const node = ensureNode(nodes, agent.id, agent.role);
  addSource(node, 'spawnGuard');
  node.role = agent.role;
  node.task = agent.task;
  if (agent.parentId) node.parentId = agent.parentId;
  if (agent.createdAt) node.createdAt = agent.createdAt;
  if (agent.completedAt) node.completedAt = agent.completedAt;
  node.updatedAt = agent.completedAt ?? agent.createdAt ?? node.updatedAt;
  applyStatus(node, managedStatusToTree(agent.status), 'spawnGuard', statusPriorities);
  node.budgetSummary = mergeBudget(node.budgetSummary, budgetFromResult(agent.result));

  const code = agent.result?.success === false || agent.status === 'failed' || agent.status === 'cancelled' || agent.status === 'killed'
    ? inferAgentFailureCode({
        failureCode: agent.result?.failureCode,
        cancellationReason: agent.result?.cancellationReason,
        error: agent.error ?? agent.result?.error,
        defaultCode: agent.status === 'cancelled'
          ? AgentFailureCode.CancelledByUser
          : agent.status === 'failed'
            ? AgentFailureCode.ModelError
            : AgentFailureCode.Unknown,
      })
    : undefined;
  applyFailure(node, code);

  const progress = resultProgress(agent.result) ?? truncate(agent.task);
  if (progress) node.progress = progress;
  setLastEvent(node, {
    summary: agent.status === 'completed'
      ? `已完成：${progress ?? agent.role}`
      : agent.status === 'failed'
        ? `遇到问题：${progress ?? agent.error ?? agent.role}`
        : agent.status === 'cancelled'
          ? `已取消：${progress ?? agent.role}`
          : `正在处理：${truncate(agent.task) ?? agent.role}`,
    at: agent.completedAt ?? agent.createdAt,
    source: 'spawnGuard',
  });
}

function mergeParallelTask(
  nodes: Map<string, AgentTreeNode>,
  statusPriorities: Map<string, number>,
  task: ParallelAgentTaskSnapshot,
): void {
  const node = ensureNode(nodes, task.taskId, task.role);
  addSource(node, 'parallelCoordinator');
  if (!node.task && task.task) node.task = task.task;
  if (task.startedAt && !node.createdAt) node.createdAt = task.startedAt;
  if (task.completedAt) node.completedAt = task.completedAt;
  node.updatedAt = task.completedAt ?? task.startedAt ?? node.updatedAt;
  applyStatus(node, parallelStatusToTree(task.status), 'parallelCoordinator', statusPriorities);
  if (!node.sources.includes('spawnGuard')) {
    node.budgetSummary = mergeBudget(node.budgetSummary, budgetFromResult(task.result));
  }
  applyFailure(node, task.failureCode);

  const progress = resultProgress(task.result)
    ?? (task.dependsOn && task.dependsOn.length > 0
      ? truncate(`等待这些任务完成：${task.dependsOn.join(', ')}`)
      : truncate(task.task));
  if (progress) node.progress = progress;
  setLastEvent(node, {
    summary: task.error
      ? `遇到问题：${truncate(task.error) ?? task.role}`
      : task.status === 'pending'
        ? `等待开始：${truncate(task.task) ?? task.role}`
        : `${statusLabel(parallelStatusToTree(task.status))}：${progress ?? task.role}`,
    at: task.completedAt ?? task.startedAt,
    source: 'parallelCoordinator',
  });
}

function mergeContextRecord(
  nodes: Map<string, AgentTreeNode>,
  statusPriorities: Map<string, number>,
  record: SubagentContextRecord,
): void {
  const role = record.snapshot?.previews[0]?.role ?? 'agent';
  const node = ensureNode(nodes, record.agentId, role);
  addSource(node, 'subagentContext');
  applyStatus(node, 'unknown', 'subagentContext', statusPriorities);
  node.updatedAt = Math.max(node.updatedAt ?? 0, record.updatedAt);
  const activeTool = activeToolFromContext(record);
  if (activeTool) node.activeTool = activeTool;
  node.budgetSummary = mergeBudget(node.budgetSummary, budgetFromContext(record));

  const progress = progressFromContext(record);
  if (progress) {
    node.progress = progress;
    setLastEvent(node, {
      summary: progress,
      at: record.updatedAt,
      source: 'subagentContext',
    });
  }
}

function mergeBackgroundAgent(
  nodes: Map<string, AgentTreeNode>,
  statusPriorities: Map<string, number>,
  handle: BackgroundSubagentHandle,
): void {
  const node = ensureNode(nodes, handle.agentId, 'background');
  addSource(node, 'backgroundRegistry');
  if (handle.startedAt && !node.createdAt) node.createdAt = handle.startedAt;
  if (handle.finishedAt) node.completedAt = handle.finishedAt;
  node.updatedAt = handle.finishedAt ?? handle.startedAt ?? node.updatedAt;
  applyStatus(node, backgroundStatusToTree(handle.status), 'backgroundRegistry', statusPriorities);
  node.budgetSummary = mergeBudget(node.budgetSummary, budgetFromResult(handle.result));
  applyFailure(node, handle.failureCode);

  const progress = resultProgress(handle.result) ?? truncate(handle.error);
  if (progress) node.progress = progress;
  setLastEvent(node, {
    summary: handle.error
      ? `遇到问题：${truncate(handle.error) ?? handle.agentId}`
      : `${statusLabel(backgroundStatusToTree(handle.status))}：${progress ?? handle.agentId}`,
    at: handle.finishedAt ?? handle.startedAt,
    source: 'backgroundRegistry',
  });
}

function mergeWorktree(
  nodes: Map<string, AgentTreeNode>,
  worktree: AgentWorktreeArtifact,
): void {
  const node = ensureNode(nodes, worktree.agentId);
  addSource(node, 'agentWorktree');
  node.worktreeState = {
    status: worktree.status,
    ...(worktree.path ? { path: worktree.path } : {}),
    ...(worktree.branch ? { branch: worktree.branch } : {}),
    ...(worktree.changedFiles ? { changedFiles: [...worktree.changedFiles] } : {}),
    ...(worktree.diffSummary ? { diffSummary: worktree.diffSummary } : {}),
    ...(worktree.evidenceRefs ? { evidenceRefs: [...worktree.evidenceRefs] } : {}),
  };
  addEvidenceRefs(node, worktree.evidenceRefs);
  if (worktree.updatedAt) {
    node.updatedAt = Math.max(node.updatedAt ?? 0, worktree.updatedAt);
    setLastEvent(node, {
      summary: worktree.path ? `产物保留在 ${worktree.path}` : '产物工作区状态已更新',
      at: worktree.updatedAt,
      source: 'agentWorktree',
    });
  }
}

function sortNodes(nodes: AgentTreeNode[]): AgentTreeNode[] {
  return nodes.sort((a, b) => {
    const timeA = a.createdAt ?? a.updatedAt ?? 0;
    const timeB = b.createdAt ?? b.updatedAt ?? 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });
}

function attachChildren(nodes: AgentTreeNode[]): { roots: AgentTreeNode[]; flat: AgentTreeNode[] } {
  const flat = sortNodes(nodes.map((node) => ({ ...node, children: [] })));
  const byId = new Map(flat.map((node) => [node.id, node]));
  const roots: AgentTreeNode[] = [];

  for (const node of flat) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const node of flat) {
    sortNodes(node.children);
  }

  return { roots, flat };
}

function summarize(nodes: AgentTreeNode[]): AgentTreeSnapshot['summary'] {
  let totalCostUsd = 0;
  let sawCost = false;
  let totalTokensUsed = 0;
  let sawTokens = false;

  for (const node of nodes) {
    if (typeof node.budgetSummary.costUsd === 'number') {
      totalCostUsd += node.budgetSummary.costUsd;
      sawCost = true;
    }
    if (typeof node.budgetSummary.tokensUsed === 'number') {
      totalTokensUsed += node.budgetSummary.tokensUsed;
      sawTokens = true;
    }
  }

  return {
    total: nodes.length,
    running: nodes.filter((node) => node.status === 'running' || node.status === 'running-recovered').length,
    completed: nodes.filter((node) => node.status === 'completed').length,
    failed: nodes.filter((node) => node.status === 'failed' || node.status === 'killed').length,
    cancelled: nodes.filter((node) => node.status === 'cancelled').length,
    blocked: nodes.filter((node) => node.status === 'blocked').length,
    withWorktree: nodes.filter((node) => node.worktreeState.status !== 'none').length,
    ...(sawCost ? { totalCostUsd } : {}),
    ...(sawTokens ? { totalTokensUsed } : {}),
  };
}

export function buildAgentTreeSnapshot(sources: AgentTreeSnapshotSources = {}): AgentTreeSnapshot {
  const nodes = new Map<string, AgentTreeNode>();
  const statusPriorities = new Map<string, number>();
  const sessionId = sources.sessionId?.trim() || undefined;
  const contextAgentIds = new Set((sources.contextRecords ?? []).map((record) => record.agentId));

  for (const agent of sources.spawnAgents ?? []) {
    if (sessionId && agent.treeId && agent.treeId !== sessionId && !contextAgentIds.has(agent.id)) {
      continue;
    }
    mergeSpawnAgent(nodes, statusPriorities, agent);
  }
  for (const task of sources.parallelTasks ?? []) {
    mergeParallelTask(nodes, statusPriorities, task);
  }
  for (const handle of sources.backgroundAgents ?? []) {
    mergeBackgroundAgent(nodes, statusPriorities, handle);
  }
  for (const record of sources.contextRecords ?? []) {
    mergeContextRecord(nodes, statusPriorities, record);
  }
  for (const worktree of sources.worktrees ?? []) {
    mergeWorktree(nodes, worktree);
  }

  const { roots, flat } = attachChildren(Array.from(nodes.values()));
  return {
    generatedAt: sources.now ?? Date.now(),
    ...(sessionId ? { sessionId } : {}),
    roots,
    nodes: flat,
    summary: summarize(flat),
  };
}

export function getAgentTreeSnapshot(options: GetAgentTreeSnapshotOptions = {}): AgentTreeSnapshot {
  const sessionId = options.sessionId?.trim() || undefined;
  return buildAgentTreeSnapshot({
    sessionId,
    now: options.now,
    spawnAgents: getSpawnGuard().list(),
    parallelTasks: getParallelAgentCoordinator().getTaskSnapshots(),
    contextRecords: getSubagentContextStore().list(sessionId),
    backgroundAgents: getBackgroundSubagentRegistry().list(),
    worktrees: options.worktrees ?? listAgentWorktreeArtifacts(),
  });
}
