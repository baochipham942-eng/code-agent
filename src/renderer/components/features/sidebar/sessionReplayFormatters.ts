import type {
  EvidenceControlSummaryProjection,
  ReplayBlock,
  ReplayTurn,
  StructuredReplay,
} from '@shared/contract/evaluation';
import type {
  AgentTrajectoryDatasetRole,
  AgentTrajectoryQualityTier,
  AgentTrajectoryTaskKind,
} from '@shared/contract/agentTrajectory';
import type { Task, TaskEvent, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ScriptRunAgentSnapshot, ScriptRunSnapshot } from '@shared/contract/scriptRun';
import type { Translations } from '../../../i18n';
import type { SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';

type FocusedReplayOwner = { kind: 'workflow'; id: string } | { kind: 'background'; id: string };
type SessionReplayLabels = Translations['sessionReplay'];

function formatDuration(ms: number | undefined, { dialog: d }: SessionReplayLabels): string {
  if (!ms || ms <= 0) return d.unknown;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} ${d.unitSecond}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes} ${d.unitMinute} ${remainder} ${d.unitSecond}` : `${minutes} ${d.unitMinute}`;
}

function formatTimestamp(timestamp: number | undefined): string | null {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString();
}

function getWorkflowSortTime(snapshot: ScriptRunSnapshot): number {
  return snapshot.finishedAt ?? snapshot.startedAt ?? 0;
}

function getBackgroundTaskSortTime(task: Task): number {
  return task.completedAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt ?? 0;
}

function getWorkflowEvidenceRunId(item: SessionReplayEvidence): string | null {
  const match = /^workflow:([^:]+):/.exec(item.id);
  return match?.[1] ?? null;
}

function getBackgroundEvidenceTaskId(item: SessionReplayEvidence): string | null {
  const match = /^background:([^:]+):/.exec(item.id);
  return match?.[1] ?? null;
}

function groupEvidenceByOwner(
  evidence: SessionReplayEvidence[],
  getOwnerId: (item: SessionReplayEvidence) => string | null,
): Map<string, SessionReplayEvidence[]> {
  const groups = new Map<string, SessionReplayEvidence[]>();
  for (const item of evidence) {
    const ownerId = getOwnerId(item);
    if (!ownerId) {
      continue;
    }
    const current = groups.get(ownerId) ?? [];
    current.push(item);
    groups.set(ownerId, current);
  }
  return groups;
}

function getFocusedReplayOwnerKey(owner: FocusedReplayOwner | null): string | null {
  return owner ? `${owner.kind}:${owner.id}` : null;
}

function formatToolDistribution(replay: StructuredReplay, labels: SessionReplayLabels): string {
  const entries = Object.entries(replay.summary.toolDistribution)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    return labels.noToolCalls;
  }

  return entries.map(([category, count]) => `${category} ${count}`).join(' · ');
}

function getTrajectoryTierToneClassName(tier: AgentTrajectoryQualityTier): string {
  switch (tier) {
    case 'G2':
      return 'border-badge-success/25 bg-emerald-500/10 text-badge-success';
    case 'G1':
      return 'border-badge-warning/25 bg-amber-500/10 text-badge-warning';
    default:
      return 'border-badge-danger/25 bg-rose-500/10 text-badge-danger';
  }
}

function getEvidenceControlToneClassName(trustLevel: EvidenceControlSummaryProjection['trustLevel']): string {
  switch (trustLevel) {
    case 'strong':
      return 'border-badge-success/25 bg-emerald-500/10 text-badge-success';
    case 'partial':
      return 'border-badge-warning/25 bg-amber-500/10 text-badge-warning';
    default:
      return 'border-badge-danger/25 bg-rose-500/10 text-badge-danger';
  }
}

function formatEvidenceControlTitle(summary: EvidenceControlSummaryProjection): string {
  const gaps = summary.gaps.length > 0 ? summary.gaps.slice(0, 8).join(' · ') : 'no evidence gaps';
  return [
    `Evidence Control ${summary.trustLevel}`,
    `${summary.totalItems} items · ${summary.totalEvidenceRefs} refs`,
    `blocked ${summary.blockedItems} · stale ${summary.staleItems} · conflicts ${summary.conflictItems}`,
    gaps,
  ].join('\n');
}

function getTrajectoryDatasetLabel(role: AgentTrajectoryDatasetRole, labels: SessionReplayLabels): string {
  switch (role) {
    case 'core_eval':
      return labels.datasetRoles.coreEval;
    case 'excluded':
      return labels.datasetRoles.excluded;
    default:
      return labels.datasetRoles.diagnostic;
  }
}

function getTrajectoryTaskKindLabel(kind: AgentTrajectoryTaskKind, labels: SessionReplayLabels): string {
  switch (kind) {
    case 'coding':
      return labels.taskKinds.coding;
    case 'search':
      return labels.taskKinds.search;
    case 'data_analysis':
      return labels.taskKinds.data;
    case 'agent_task':
      return labels.taskKinds.agentTask;
    case 'ordinary_chat':
      return labels.taskKinds.chat;
    default:
      return labels.taskKinds.other;
  }
}

const TRAJECTORY_DATASET_ROLE_OPTIONS: AgentTrajectoryDatasetRole[] = ['core_eval', 'diagnostic', 'excluded'];

function lastPathSegment(value: string | undefined): string | null {
  if (!value) return null;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function truncateContent(content: string, maxLength = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeBlockText(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function shouldRenderBlockDetail(label: string, detail: string): boolean {
  const normalizedLabel = normalizeBlockText(label);
  const normalizedDetail = normalizeBlockText(detail);
  return normalizedDetail.length > 0 && normalizedLabel !== normalizedDetail;
}

function formatWorkflowStatus(snapshot: ScriptRunSnapshot, { dialog: d }: SessionReplayLabels): string {
  switch (snapshot.status) {
    case 'running':
      return snapshot.currentPhase ? d.workflowRunningPhase.replace('{phase}', snapshot.currentPhase) : d.running;
    case 'completed':
      return d.completed;
    case 'failed':
      return snapshot.error ? d.failedPrefix.replace('{message}', truncateContent(snapshot.error, 48)) : d.failed;
    case 'cancelled':
      return d.cancelled;
    default:
      return d.pending;
  }
}

function formatWorkflowRunMeta(snapshot: ScriptRunSnapshot, labels: SessionReplayLabels): string {
  const started = formatTimestamp(snapshot.startedAt);
  const finished = formatTimestamp(snapshot.finishedAt);
  return [
    `run ${snapshot.runId}`,
    started ? labels.dialog.metaStarted.replace('{time}', started) : null,
    finished ? labels.dialog.metaFinished.replace('{time}', finished) : null,
  ].filter(Boolean).join(' · ');
}

function formatWorkflowAgentSummary(snapshot: ScriptRunSnapshot): string {
  const items = [
    snapshot.runningCount > 0 ? `${snapshot.runningCount} running` : null,
    snapshot.doneCount > 0 ? `${snapshot.doneCount} done` : null,
    snapshot.errorCount > 0 ? `${snapshot.errorCount} issue` : null,
  ].filter(Boolean);
  return items.length > 0 ? items.join(' · ') : `${snapshot.agents.length} agents`;
}

function formatTaskStatus(task: Task, { dialog: d }: SessionReplayLabels): string {
  switch (task.status) {
    case 'queued':
      return d.taskQueued;
    case 'running':
      return d.running;
    case 'waiting_input':
      return d.taskWaitingInput;
    case 'stalled':
      return task.progress?.label ? d.taskStalledLabel.replace('{label}', task.progress.label) : d.taskStalled;
    case 'completed':
      return d.completed;
    case 'failed':
      return task.failure?.message ? d.failedPrefix.replace('{message}', truncateContent(task.failure.message, 48)) : d.failed;
    case 'cancelled':
      return d.cancelled;
    case 'paused':
      return d.taskPaused;
    case 'expired':
      return d.taskExpired;
    case 'orphaned':
      return d.taskOrphaned;
    default:
      return task.status;
  }
}

function formatBackgroundTaskMeta(task: Task, labels: SessionReplayLabels): string {
  const started = formatTimestamp(task.startedAt);
  const updated = formatTimestamp(task.updatedAt);
  return [
    `task ${task.id}`,
    started ? labels.dialog.metaStarted.replace('{time}', started) : null,
    updated ? labels.dialog.metaUpdated.replace('{time}', updated) : null,
  ].filter(Boolean).join(' · ');
}

function formatTaskOutputRef(ref: TaskOutputRef): string {
  const pathOrUrl = ref.path || ref.uri || undefined;
  const label = ref.label || lastPathSegment(pathOrUrl) || ref.type;
  return ref.type === 'trace' || ref.type === 'replay'
    ? `${ref.type === 'trace' ? 'Trace' : 'Replay'} · ${label}`
    : `${label}`;
}

function formatWorkflowAgentStatus(agent: ScriptRunAgentSnapshot, { dialog: d }: SessionReplayLabels): string {
  switch (agent.status) {
    case 'running':
      return d.running;
    case 'done':
      return d.agentDone;
    case 'error':
      return d.failed;
    case 'queued':
      return d.agentQueued;
    case 'skipped':
      return d.agentSkipped;
    default:
      return agent.status;
  }
}

function formatWorkflowAgentDetail(agent: ScriptRunAgentSnapshot): string {
  const items = [agent.phase, agent.model, agent.cached ? 'cached' : null, agent.hasSchema ? 'schema' : null].filter(
    Boolean,
  );
  return items.length > 0 ? items.join(' · ') : agent.id;
}

function formatWorkflowAgentBody(agent: ScriptRunAgentSnapshot): string | null {
  const value = agent.resultPreview || agent.error || agent.promptPreview;
  return value ? truncateContent(value, 96) : null;
}

function formatTaskEventLabel(event: TaskEvent): string {
  const status = event.status ? ` · ${event.status}` : '';
  return `${event.type}${status}`;
}

function formatTaskEventDetail(event: TaskEvent): string {
  if (event.message) {
    return truncateContent(event.message, 96);
  }
  if (event.data !== undefined) {
    try {
      return truncateContent(JSON.stringify(event.data), 96);
    } catch {
      return 'event data';
    }
  }
  return new Date(event.timestamp).toLocaleTimeString();
}

function formatBlockLabel(block: ReplayBlock, { dialog: d }: SessionReplayLabels): string {
  if (block.type === 'tool_call' && block.toolCall) {
    return (block.toolCall.success ? d.blockToolSuccess : d.blockToolFailed).replace('{name}', block.toolCall.name);
  }
  if (block.type === 'model_call' && block.modelDecision) {
    const model = block.modelDecision.resolvedModel || block.modelDecision.model;
    return model ? d.blockModel.replace('{model}', model) : d.blockModelCall;
  }
  if (block.type === 'tool_result') return d.blockToolResult;
  if (block.type === 'context_event') return d.blockContext;
  if (block.type === 'event') return d.blockEvent;
  if (block.type === 'thinking') return d.blockThinking;
  if (block.type === 'user') return d.blockUser;
  if (block.type === 'error') return d.blockError;
  return d.blockReply;
}

function formatBlockDetail(block: ReplayBlock, labels: SessionReplayLabels): string {
  const d = labels.dialog;
  if (block.type === 'tool_call' && block.toolCall) {
    const duration = formatDuration(block.toolCall.duration, labels);
    const outcome = block.toolCall.successKnown === false ? d.outcomeUnknown : block.toolCall.success ? d.outcomeSuccess : d.failed;
    return `${outcome} · ${duration}`;
  }
  if (block.type === 'model_call' && block.modelDecision) {
    const tokens = block.modelDecision.inputTokens + block.modelDecision.outputTokens;
    const latency = formatDuration(block.modelDecision.latencyMs, labels);
    return `${tokens} tokens · ${latency}`;
  }
  if (block.type === 'event') {
    // 去重修复（label 收敛为「事件」）后 summary 必须落在 detail 里，
    // 不能被 durationMs 短路吞掉（Codex 审计 R1）。
    const summary = normalizeBlockText(block.event?.summary || block.content);
    const duration = block.event?.durationMs ? formatDuration(block.event.durationMs, labels) : '';
    if (summary && duration) return `${summary} · ${duration}`;
    return summary || duration;
  }
  // 完整正文留给下钻视图；timeline 行内截断，防超大 tool_result 拖垮弹层。
  return truncateContent(normalizeBlockText(block.content), 160);
}

function getBlockToneClassName(block: ReplayBlock): string {
  if (block.type === 'error' || (block.type === 'tool_call' && block.toolCall?.success === false)) {
    return 'border-badge-danger/20 bg-rose-500/10 text-badge-danger';
  }
  if (block.type === 'tool_call') {
    return 'border-badge-info/20 bg-cyan-500/10 text-badge-info';
  }
  if (block.type === 'model_call') {
    return 'border-badge-accent/20 bg-violet-500/10 text-badge-accent';
  }
  return 'border-zinc-800 bg-zinc-900/50 text-zinc-300';
}

function getTurnSummary(turn: ReplayTurn): string {
  const toolCount = turn.blocks.filter((block) => block.type === 'tool_call').length;
  const modelCount = turn.blocks.filter((block) => block.type === 'model_call').length;
  const errorCount = turn.blocks.filter(
    (block) => block.type === 'error' || (block.type === 'tool_call' && block.toolCall?.success === false),
  ).length;
  const items = [
    `${turn.blocks.length} blocks`,
    toolCount > 0 ? `${toolCount} tools` : null,
    modelCount > 0 ? `${modelCount} model` : null,
    errorCount > 0 ? `${errorCount} issue` : null,
  ].filter(Boolean);
  return items.join(' · ');
}

function formatEvidenceLabel(item: SessionReplayEvidence): string {
  return `${item.type === 'trace' ? 'Trace' : 'Replay'} · ${item.label}`;
}

export {
  TRAJECTORY_DATASET_ROLE_OPTIONS,
  formatBackgroundTaskMeta,
  formatBlockDetail,
  formatBlockLabel,
  formatDuration,
  formatEvidenceControlTitle,
  formatEvidenceLabel,
  formatTaskEventDetail,
  formatTaskEventLabel,
  formatTaskOutputRef,
  formatTaskStatus,
  formatToolDistribution,
  formatWorkflowAgentBody,
  formatWorkflowAgentDetail,
  formatWorkflowAgentStatus,
  formatWorkflowAgentSummary,
  formatWorkflowRunMeta,
  formatWorkflowStatus,
  getBackgroundEvidenceTaskId,
  getBackgroundTaskSortTime,
  getBlockToneClassName,
  getEvidenceControlToneClassName,
  getFocusedReplayOwnerKey,
  getTrajectoryDatasetLabel,
  getTrajectoryTaskKindLabel,
  getTrajectoryTierToneClassName,
  getTurnSummary,
  getWorkflowEvidenceRunId,
  getWorkflowSortTime,
  groupEvidenceByOwner,
  shouldRenderBlockDetail,
  truncateContent,
};
export type {
  FocusedReplayOwner,
  SessionReplayLabels,
};
