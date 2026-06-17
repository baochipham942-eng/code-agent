import React from 'react';
import { X } from 'lucide-react';
import { IconButton, Modal } from '../../primitives';
import type { ReplayBlock, ReplayTurn, StructuredReplay } from '@shared/contract/evaluation';
import type { Task, TaskEvent, TaskOutputRef } from '@shared/contract/backgroundTask';
import type { ScriptRunAgentSnapshot, ScriptRunSnapshot } from '@shared/contract/scriptRun';
import type { SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';

type FocusedReplayOwner =
  | { kind: 'workflow'; id: string }
  | { kind: 'background'; id: string };

export interface SessionReplaySummaryDialogProps {
  sessionTitle: string;
  replay: StructuredReplay;
  workflowRuns?: ScriptRunSnapshot[];
  backgroundTasks?: Task[];
  evidence?: SessionReplayEvidence[];
  onOpenEvidence?: (evidence: SessionReplayEvidence) => void | Promise<void>;
  onClose: () => void;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '未知';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
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

function formatToolDistribution(replay: StructuredReplay): string {
  const entries = Object.entries(replay.summary.toolDistribution)
    .filter(([, count]) => count > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    return '无工具调用';
  }

  return entries.map(([category, count]) => `${category} ${count}`).join(' · ');
}

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

function formatWorkflowStatus(snapshot: ScriptRunSnapshot): string {
  switch (snapshot.status) {
    case 'running':
      return snapshot.currentPhase ? `执行中：${snapshot.currentPhase}` : '执行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return snapshot.error ? `失败：${truncateContent(snapshot.error, 48)}` : '失败';
    case 'cancelled':
      return '已取消';
    default:
      return '待开始';
  }
}

function formatWorkflowRunMeta(snapshot: ScriptRunSnapshot): string {
  const items = [
    `run ${snapshot.runId}`,
    formatTimestamp(snapshot.startedAt) ? `开始 ${formatTimestamp(snapshot.startedAt)}` : null,
    formatTimestamp(snapshot.finishedAt) ? `结束 ${formatTimestamp(snapshot.finishedAt)}` : null,
  ].filter(Boolean);
  return items.join(' · ');
}

function formatWorkflowAgentSummary(snapshot: ScriptRunSnapshot): string {
  const items = [
    snapshot.runningCount > 0 ? `${snapshot.runningCount} running` : null,
    snapshot.doneCount > 0 ? `${snapshot.doneCount} done` : null,
    snapshot.errorCount > 0 ? `${snapshot.errorCount} issue` : null,
  ].filter(Boolean);
  return items.length > 0 ? items.join(' · ') : `${snapshot.agents.length} agents`;
}

function formatTaskStatus(task: Task): string {
  switch (task.status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'waiting_input':
      return '等待输入';
    case 'stalled':
      return task.progress?.label ? `启动变慢：${task.progress.label}` : '启动变慢';
    case 'completed':
      return '已完成';
    case 'failed':
      return task.failure?.message ? `失败：${truncateContent(task.failure.message, 48)}` : '失败';
    case 'cancelled':
      return '已取消';
    case 'paused':
      return '已暂停';
    case 'expired':
      return '已过期';
    case 'orphaned':
      return '运行进程已丢失';
    default:
      return task.status;
  }
}

function formatBackgroundTaskMeta(task: Task): string {
  const items = [
    `task ${task.id}`,
    formatTimestamp(task.startedAt) ? `开始 ${formatTimestamp(task.startedAt)}` : null,
    formatTimestamp(task.updatedAt) ? `更新 ${formatTimestamp(task.updatedAt)}` : null,
  ].filter(Boolean);
  return items.join(' · ');
}

function formatTaskOutputRef(ref: TaskOutputRef): string {
  const pathOrUrl = ref.path || ref.uri || undefined;
  const label = ref.label || lastPathSegment(pathOrUrl) || ref.type;
  return ref.type === 'trace' || ref.type === 'replay'
    ? `${ref.type === 'trace' ? 'Trace' : 'Replay'} · ${label}`
    : `${label}`;
}

function formatWorkflowAgentStatus(agent: ScriptRunAgentSnapshot): string {
  switch (agent.status) {
    case 'running':
      return '执行中';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    case 'queued':
      return '排队';
    case 'skipped':
      return '跳过';
    default:
      return agent.status;
  }
}

function formatWorkflowAgentDetail(agent: ScriptRunAgentSnapshot): string {
  const items = [
    agent.phase,
    agent.model,
    agent.cached ? 'cached' : null,
    agent.hasSchema ? 'schema' : null,
  ].filter(Boolean);
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

function formatBlockLabel(block: ReplayBlock): string {
  if (block.type === 'tool_call' && block.toolCall) {
    return block.toolCall.success ? `工具 ${block.toolCall.name}` : `工具失败 ${block.toolCall.name}`;
  }
  if (block.type === 'model_call' && block.modelDecision) {
    const model = block.modelDecision.resolvedModel || block.modelDecision.model;
    return model ? `模型 ${model}` : '模型调用';
  }
  if (block.type === 'tool_result') return '工具结果';
  if (block.type === 'context_event') return '上下文';
  if (block.type === 'event') return block.event?.summary || '事件';
  if (block.type === 'thinking') return '思考';
  if (block.type === 'user') return '用户';
  if (block.type === 'error') return '错误';
  return '回复';
}

function formatBlockDetail(block: ReplayBlock): string {
  if (block.type === 'tool_call' && block.toolCall) {
    const duration = formatDuration(block.toolCall.duration);
    const outcome = block.toolCall.successKnown === false
      ? '结果未知'
      : block.toolCall.success
        ? '成功'
        : '失败';
    return `${outcome} · ${duration}`;
  }
  if (block.type === 'model_call' && block.modelDecision) {
    const tokens = block.modelDecision.inputTokens + block.modelDecision.outputTokens;
    const latency = formatDuration(block.modelDecision.latencyMs);
    return `${tokens} tokens · ${latency}`;
  }
  if (block.type === 'event' && block.event?.durationMs) {
    return formatDuration(block.event.durationMs);
  }
  return truncateContent(block.content, 90);
}

function getBlockToneClassName(block: ReplayBlock): string {
  if (block.type === 'error' || (block.type === 'tool_call' && block.toolCall?.success === false)) {
    return 'border-rose-500/20 bg-rose-500/10 text-rose-200';
  }
  if (block.type === 'tool_call') {
    return 'border-cyan-500/20 bg-cyan-500/10 text-cyan-200';
  }
  if (block.type === 'model_call') {
    return 'border-violet-500/20 bg-violet-500/10 text-violet-200';
  }
  return 'border-zinc-800 bg-zinc-900/50 text-zinc-300';
}

function getTurnSummary(turn: ReplayTurn): string {
  const toolCount = turn.blocks.filter((block) => block.type === 'tool_call').length;
  const modelCount = turn.blocks.filter((block) => block.type === 'model_call').length;
  const errorCount = turn.blocks.filter((block) => (
    block.type === 'error' || (block.type === 'tool_call' && block.toolCall?.success === false)
  )).length;
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

function renderEvidenceChip(
  item: SessionReplayEvidence,
  onOpenEvidence?: (evidence: SessionReplayEvidence) => void | Promise<void>,
): React.ReactElement {
  const label = formatEvidenceLabel(item);
  const className = 'rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] text-zinc-400';
  if (!onOpenEvidence || item.actionKind === 'sessionReplay') {
    return (
      <span
        key={item.id}
        title={item.title}
        className={className}
      >
        {label}
      </span>
    );
  }
  return (
    <button
      key={item.id}
      type="button"
      title={item.title}
      aria-label={`打开证据 ${label}`}
      onClick={(event) => {
        event.preventDefault();
        void onOpenEvidence(item);
      }}
      className={`${className} transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 focus:outline-hidden`}
    >
      {label}
    </button>
  );
}

export const SessionReplaySummaryDialog: React.FC<SessionReplaySummaryDialogProps> = ({
  sessionTitle,
  replay,
  workflowRuns = [],
  backgroundTasks = [],
  evidence = [],
  onOpenEvidence,
  onClose,
}) => {
  const [focusedReplayOwner, setFocusedReplayOwner] = React.useState<FocusedReplayOwner | null>(null);
  const completeness = replay.summary.telemetryCompleteness;
  const incompleteReasons = completeness?.incompleteReasons ?? [];
  const issueCount = replay.summary.deviations?.length ?? 0;
  const visibleTurns = replay.turns.slice(0, 8);
  const hiddenTurnCount = Math.max(0, replay.turns.length - visibleTurns.length);
  const workflowEvidenceByRunId = groupEvidenceByOwner(evidence, getWorkflowEvidenceRunId);
  const backgroundEvidenceByTaskId = groupEvidenceByOwner(evidence, getBackgroundEvidenceTaskId);
  const sortedWorkflowRuns = [...workflowRuns].sort((a, b) => getWorkflowSortTime(b) - getWorkflowSortTime(a));
  const sortedBackgroundTasks = [...backgroundTasks].sort((a, b) => (
    getBackgroundTaskSortTime(b) - getBackgroundTaskSortTime(a)
  ));
  const visibleWorkflowRuns = sortedWorkflowRuns.slice(0, 3);
  const visibleBackgroundTasks = sortedBackgroundTasks.slice(0, 3);
  const attachedEvidenceIds = new Set<string>();
  for (const snapshot of visibleWorkflowRuns) {
    for (const item of workflowEvidenceByRunId.get(snapshot.runId) ?? []) {
      attachedEvidenceIds.add(item.id);
    }
  }
  for (const task of visibleBackgroundTasks) {
    for (const item of backgroundEvidenceByTaskId.get(task.id) ?? []) {
      attachedEvidenceIds.add(item.id);
    }
  }
  const remainingEvidence = evidence.filter((item) => !attachedEvidenceIds.has(item.id));
  const visibleEvidence = remainingEvidence.slice(0, 4);
  const hiddenWorkflowRunCount = Math.max(0, workflowRuns.length - visibleWorkflowRuns.length);
  const hiddenBackgroundTaskCount = Math.max(0, backgroundTasks.length - visibleBackgroundTasks.length);
  const hiddenEvidenceCount = Math.max(0, remainingEvidence.length - visibleEvidence.length);
  const hasWorkflowEvidence = visibleWorkflowRuns.length > 0
    || visibleBackgroundTasks.length > 0
    || visibleEvidence.length > 0;
  const focusedWorkflowRun = focusedReplayOwner?.kind === 'workflow'
    ? visibleWorkflowRuns.find((snapshot) => snapshot.runId === focusedReplayOwner.id) ?? null
    : null;
  const focusedBackgroundTask = focusedReplayOwner?.kind === 'background'
    ? visibleBackgroundTasks.find((task) => task.id === focusedReplayOwner.id) ?? null
    : null;
  const activeFocusedOwner = focusedWorkflowRun || focusedBackgroundTask ? focusedReplayOwner : null;
  const activeFocusedOwnerKey = getFocusedReplayOwnerKey(activeFocusedOwner);
  const focusedEvidence = focusedWorkflowRun
    ? workflowEvidenceByRunId.get(focusedWorkflowRun.runId) ?? []
    : focusedBackgroundTask
      ? backgroundEvidenceByTaskId.get(focusedBackgroundTask.id) ?? []
      : [];

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={sessionTitle}
      size="md"
      className="!max-w-3xl"
      zIndex={10000}
      header={
        <>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium uppercase tracking-wide text-violet-300">Replay</div>
            <h2 className="mt-1 truncate text-sm font-semibold text-zinc-100">{sessionTitle}</h2>
            <p className="mt-1 truncate text-[11px] text-zinc-500">{replay.traceIdentity.replayKey}</p>
          </div>
          <IconButton
            variant="default"
            size="sm"
            icon={<X className="h-4 w-4" />}
            aria-label="关闭 Replay 摘要"
            onClick={onClose}
          />
        </>
      }
    >
        <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
            <dt className="text-zinc-500">Turns</dt>
            <dd className="mt-1 font-medium text-zinc-200">{replay.summary.totalTurns}</dd>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
            <dt className="text-zinc-500">来源</dt>
            <dd className="mt-1 font-medium text-zinc-200">{replay.dataSource}</dd>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
            <dt className="text-zinc-500">耗时</dt>
            <dd className="mt-1 font-medium text-zinc-200">{formatDuration(replay.summary.totalDurationMs)}</dd>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2">
            <dt className="text-zinc-500">偏差</dt>
            <dd className="mt-1 font-medium text-zinc-200">{issueCount}</dd>
          </div>
        </dl>

        <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-xs">
          <div className="text-zinc-500">工具分布</div>
          <div className="mt-1 text-zinc-300">{formatToolDistribution(replay)}</div>
        </div>

        {hasWorkflowEvidence && (
          <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="font-medium text-zinc-300">Workflow / Background</div>
              <div className="text-[10px] text-zinc-600">
                {workflowRuns.length} workflow · {backgroundTasks.length} task · {evidence.length} evidence
              </div>
            </div>

            <div className="grid gap-2">
              {activeFocusedOwner && (
                <div className="rounded-md border border-zinc-700 bg-zinc-900/60 p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">聚焦证据</div>
                      <div className="mt-0.5 truncate text-xs font-medium text-zinc-200">
                        {focusedWorkflowRun
                          ? (focusedWorkflowRun.goal ? `Workflow: ${focusedWorkflowRun.goal}` : `Workflow ${focusedWorkflowRun.runId}`)
                          : focusedBackgroundTask?.title}
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                        {focusedWorkflowRun
                          ? `${formatWorkflowStatus(focusedWorkflowRun)} · ${formatWorkflowRunMeta(focusedWorkflowRun)}`
                          : focusedBackgroundTask
                            ? `${formatTaskStatus(focusedBackgroundTask)} · ${formatBackgroundTaskMeta(focusedBackgroundTask)}`
                            : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFocusedReplayOwner(null)}
                      className="shrink-0 rounded border border-zinc-700 bg-zinc-950/40 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200"
                    >
                      退出聚焦
                    </button>
                  </div>
                  {focusedEvidence.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1" aria-label="聚焦证据列表">
                      {focusedEvidence.map((item) => renderEvidenceChip(item, onOpenEvidence))}
                    </div>
                  ) : (
                    <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px] text-zinc-500">
                      这个执行现场暂未关联 replay/trace 证据
                    </div>
                  )}
                  {focusedWorkflowRun && focusedWorkflowRun.phases.length > 0 && (
                    <div className="mt-2 truncate text-[10px] text-zinc-500">
                      Phases：{focusedWorkflowRun.phases.slice(0, 6).join(' · ')}
                    </div>
                  )}
                  {focusedWorkflowRun && focusedWorkflowRun.agents.length > 0 && (
                    <div className="mt-2 grid gap-1" aria-label="聚焦 workflow agents">
                      <div className="text-[10px] font-medium text-zinc-400">
                        Agents · {formatWorkflowAgentSummary(focusedWorkflowRun)}
                      </div>
                      {focusedWorkflowRun.agents.slice(0, 6).map((agent) => {
                        const body = formatWorkflowAgentBody(agent);
                        return (
                          <div
                            key={`focused:${focusedWorkflowRun.runId}:agent:${agent.id}`}
                            className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-zinc-300">
                                {agent.label || 'workflow agent'}
                              </span>
                              <span className="shrink-0 text-zinc-500">{formatWorkflowAgentStatus(agent)}</span>
                            </div>
                            <div className="mt-0.5 truncate text-zinc-500">{formatWorkflowAgentDetail(agent)}</div>
                            {body && <div className="mt-0.5 truncate text-zinc-400">{body}</div>}
                          </div>
                        );
                      })}
                      {focusedWorkflowRun.agents.length > 6 && (
                        <div className="px-1 text-[10px] text-zinc-600">
                          另有 {focusedWorkflowRun.agents.length - 6} 个 workflow agent
                        </div>
                      )}
                    </div>
                  )}
                  {focusedWorkflowRun && focusedWorkflowRun.logs.length > 0 && (
                    <div className="mt-2 rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1">
                      <div className="text-[10px] font-medium text-zinc-400">Logs</div>
                      <div className="mt-1 grid gap-0.5 text-[10px] text-zinc-500">
                        {focusedWorkflowRun.logs.slice(-5).map((log, index) => (
                          <div key={`focused:${focusedWorkflowRun.runId}:log:${index}`} className="truncate">
                            {truncateContent(log, 120)}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {focusedBackgroundTask && focusedBackgroundTask.outputRefs.length > 0 && (
                    <div className="mt-2" aria-label="聚焦 background outputs">
                      <div className="mb-1 text-[10px] font-medium text-zinc-400">Outputs</div>
                      <div className="flex flex-wrap gap-1">
                        {focusedBackgroundTask.outputRefs.slice(0, 6).map((ref) => (
                          <span
                            key={`focused:${focusedBackgroundTask.id}:output:${ref.id}`}
                            title={ref.path || ref.uri || ref.label}
                            className="rounded border border-zinc-700/60 bg-zinc-950/40 px-1.5 py-0.5 text-[10px] text-zinc-400"
                          >
                            {formatTaskOutputRef(ref)}
                          </span>
                        ))}
                        {focusedBackgroundTask.outputRefs.length > 6 && (
                          <span className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-600">
                            另有 {focusedBackgroundTask.outputRefs.length - 6} 个 output
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {focusedBackgroundTask && focusedBackgroundTask.events.length > 0 && (
                    <div className="mt-2 grid gap-1" aria-label="聚焦 background events">
                      <div className="text-[10px] font-medium text-zinc-400">Events</div>
                      {focusedBackgroundTask.events.slice(-5).map((event) => (
                        <div
                          key={`focused:${event.id}`}
                          className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-[10px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium text-zinc-300">
                              {formatTaskEventLabel(event)}
                            </span>
                            <span className="shrink-0 text-zinc-600">
                              {new Date(event.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="mt-0.5 truncate text-zinc-500">{formatTaskEventDetail(event)}</div>
                        </div>
                      ))}
                      {focusedBackgroundTask.events.length > 5 && (
                        <div className="px-1 text-[10px] text-zinc-600">
                          另有 {focusedBackgroundTask.events.length - 5} 个 task event
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {visibleWorkflowRuns.map((snapshot) => {
                const runEvidence = workflowEvidenceByRunId.get(snapshot.runId) ?? [];
                const owner: FocusedReplayOwner = { kind: 'workflow', id: snapshot.runId };
                const ownerKey = getFocusedReplayOwnerKey(owner);
                const focused = ownerKey === activeFocusedOwnerKey;
                return (
                  <div
                    key={snapshot.runId}
                    className={`rounded-md border p-2 ${
                      focused
                        ? 'border-violet-300/40 bg-violet-500/10'
                        : 'border-violet-500/15 bg-violet-500/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-violet-200">
                          {snapshot.goal ? `Workflow: ${snapshot.goal}` : `Workflow ${snapshot.runId}`}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-violet-200/60">
                          {formatWorkflowStatus(snapshot)}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-violet-200/45">
                          {formatWorkflowRunMeta(snapshot)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[10px] text-violet-200/60">
                        <div>{formatWorkflowAgentSummary(snapshot)}</div>
                        {snapshot.durationMs !== undefined && <div>{formatDuration(snapshot.durationMs)}</div>}
                        <button
                          type="button"
                          aria-pressed={focused ? 'true' : 'false'}
                          aria-label={`聚焦 workflow ${snapshot.runId}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setFocusedReplayOwner(focused ? null : owner);
                          }}
                          className="mt-1 rounded border border-violet-500/20 bg-zinc-950/30 px-1.5 py-0.5 text-[10px] text-violet-200/70 transition-colors hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-violet-100"
                        >
                          {focused ? '已聚焦' : '聚焦'}
                        </button>
                      </div>
                    </div>
                    {snapshot.phases.length > 0 && (
                      <div className="mt-1 truncate text-[10px] text-zinc-500">
                        Phases：{snapshot.phases.slice(0, 4).join(' · ')}
                      </div>
                    )}
                    {runEvidence.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1" aria-label={`Workflow ${snapshot.runId} 证据`}>
                        {runEvidence.map((item) => renderEvidenceChip(item, onOpenEvidence))}
                      </div>
                    )}
                    {snapshot.agents.length > 0 && (
                      <div className="mt-2 grid gap-1">
                        {snapshot.agents.slice(0, 4).map((agent) => {
                          const body = formatWorkflowAgentBody(agent);
                          return (
                            <div
                              key={agent.id}
                              className="rounded border border-violet-500/10 bg-zinc-950/40 px-2 py-1 text-[10px]"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate font-medium text-violet-100">
                                  {agent.label || 'workflow agent'}
                                </span>
                                <span className="shrink-0 text-violet-200/60">
                                  {formatWorkflowAgentStatus(agent)}
                                </span>
                              </div>
                              <div className="mt-0.5 truncate text-zinc-500">{formatWorkflowAgentDetail(agent)}</div>
                              {body && <div className="mt-0.5 truncate text-zinc-400">{body}</div>}
                            </div>
                          );
                        })}
                        {snapshot.agents.length > 4 && (
                          <div className="px-1 text-[10px] text-zinc-600">
                            另有 {snapshot.agents.length - 4} 个 workflow agent
                          </div>
                        )}
                      </div>
                    )}
                    {snapshot.logs.length > 0 && (
                      <div className="mt-2 rounded border border-violet-500/10 bg-zinc-950/40 px-2 py-1">
                        <div className="text-[10px] font-medium text-violet-100">Logs</div>
                        <div className="mt-1 grid gap-0.5 text-[10px] text-zinc-500">
                          {snapshot.logs.slice(-3).map((log, index) => (
                            <div key={`${snapshot.runId}:log:${index}`} className="truncate">
                              {truncateContent(log, 110)}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {hiddenWorkflowRunCount > 0 && (
                <div className="px-1 text-[10px] text-zinc-600">
                  另有 {hiddenWorkflowRunCount} 个 workflow run
                </div>
              )}

              {visibleBackgroundTasks.map((task) => {
                const taskEvidence = backgroundEvidenceByTaskId.get(task.id) ?? [];
                const owner: FocusedReplayOwner = { kind: 'background', id: task.id };
                const ownerKey = getFocusedReplayOwnerKey(owner);
                const focused = ownerKey === activeFocusedOwnerKey;
                return (
                  <div
                    key={task.id}
                    className={`rounded-md border p-2 ${
                      focused
                        ? 'border-cyan-300/40 bg-cyan-500/10'
                        : 'border-cyan-500/15 bg-cyan-500/5'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-cyan-200">{task.title}</div>
                        <div className="mt-0.5 truncate text-[10px] text-cyan-200/60">
                          {formatTaskStatus(task)}
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-cyan-200/45">
                          {formatBackgroundTaskMeta(task)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[10px] text-cyan-200/60">
                        <div>{task.source}</div>
                        {task.durationMs !== undefined && <div>{formatDuration(task.durationMs)}</div>}
                        <button
                          type="button"
                          aria-pressed={focused ? 'true' : 'false'}
                          aria-label={`聚焦 background task ${task.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setFocusedReplayOwner(focused ? null : owner);
                          }}
                          className="mt-1 rounded border border-cyan-500/20 bg-zinc-950/30 px-1.5 py-0.5 text-[10px] text-cyan-200/70 transition-colors hover:border-cyan-400/40 hover:bg-cyan-500/10 hover:text-cyan-100"
                        >
                          {focused ? '已聚焦' : '聚焦'}
                        </button>
                      </div>
                    </div>
                    {task.outputRefs.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {task.outputRefs.slice(0, 4).map((ref) => (
                          <span
                            key={ref.id}
                            title={ref.path || ref.uri || ref.label}
                            className="rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] text-zinc-400"
                          >
                            {formatTaskOutputRef(ref)}
                          </span>
                        ))}
                      </div>
                    )}
                    {taskEvidence.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1" aria-label={`Background task ${task.id} 证据`}>
                        {taskEvidence.map((item) => renderEvidenceChip(item, onOpenEvidence))}
                      </div>
                    )}
                    {task.events.length > 0 && (
                      <div className="mt-2 grid gap-1">
                        {task.events.slice(-3).map((event) => (
                          <div
                            key={event.id}
                            className="rounded border border-cyan-500/10 bg-zinc-950/40 px-2 py-1 text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium text-cyan-100">
                                {formatTaskEventLabel(event)}
                              </span>
                              <span className="shrink-0 text-cyan-200/50">
                                {new Date(event.timestamp).toLocaleTimeString()}
                              </span>
                            </div>
                            <div className="mt-0.5 truncate text-zinc-500">{formatTaskEventDetail(event)}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {hiddenBackgroundTaskCount > 0 && (
                <div className="px-1 text-[10px] text-zinc-600">
                  另有 {hiddenBackgroundTaskCount} 个 background task
                </div>
              )}

              {visibleEvidence.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-medium text-zinc-500">其他证据</div>
                  <div className="flex flex-wrap gap-1" aria-label="其他证据">
                    {visibleEvidence.map((item) => renderEvidenceChip(item, onOpenEvidence))}
                    {hiddenEvidenceCount > 0 && (
                      <span className="rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 text-[10px] text-zinc-600">
                        另有 {hiddenEvidenceCount} 个 evidence
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-zinc-300">Timeline</div>
            {hiddenTurnCount > 0 && (
              <div className="text-[10px] text-zinc-600">另有 {hiddenTurnCount} 轮未展示</div>
            )}
          </div>
          {visibleTurns.length === 0 ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-2 text-xs text-zinc-500">
              Replay 暂无 turn 明细
            </div>
          ) : (
            <div className="grid gap-2">
              {visibleTurns.map((turn) => (
                <div key={turn.turnNumber} className="rounded-md border border-zinc-800 bg-zinc-900/35 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-zinc-200">第 {turn.turnNumber} 轮</div>
                      <div className="mt-0.5 truncate text-[10px] text-zinc-600">{getTurnSummary(turn)}</div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] text-zinc-600">
                      <div>{formatDuration(turn.durationMs)}</div>
                      <div>{turn.inputTokens + turn.outputTokens} tokens</div>
                    </div>
                  </div>
                  {turn.blocks.length > 0 && (
                    <div className="mt-2 grid gap-1">
                      {turn.blocks.slice(0, 6).map((block, index) => (
                        <div
                          key={`${turn.turnNumber}:${block.type}:${block.timestamp}:${index}`}
                          className={`rounded border px-2 py-1 text-[11px] ${getBlockToneClassName(block)}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="min-w-0 truncate font-medium">{formatBlockLabel(block)}</span>
                            <span className="shrink-0 text-[10px] opacity-70">{block.type}</span>
                          </div>
                          <div className="mt-0.5 truncate opacity-80">{formatBlockDetail(block)}</div>
                        </div>
                      ))}
                      {turn.blocks.length > 6 && (
                        <div className="px-2 text-[10px] text-zinc-600">
                          另有 {turn.blocks.length - 6} 个 block
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {incompleteReasons.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-200">
            Replay 数据不完整：{incompleteReasons.join(' · ')}
          </div>
        )}
    </Modal>
  );
};

export default SessionReplaySummaryDialog;
