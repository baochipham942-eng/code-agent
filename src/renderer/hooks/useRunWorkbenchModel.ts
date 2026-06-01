import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useTaskStore } from '../stores/taskStore';
import { useCronStore } from '../stores/cronStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';
import { useStatusRailModel } from './useStatusRailModel';
import type {
  RunWorkbenchModel,
  SubagentRunView,
  TaskRecord,
  TaskRecordOutputRef,
} from '../types/runWorkbench';
import type { ScriptRunAgentSnapshot, ScriptRunSnapshot } from '@shared/contract/scriptRun';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';
import {
  getLongTaskStatusLabel,
  normalizeLongTaskStatus,
  type LongTaskUiStatus,
} from '@shared/contract/productClosure';
import {
  buildLoopDecisionViews,
  buildMemoryActivityEvents,
  buildOutputArtifactViews,
  buildRunUiState,
  buildSessionTaskRecord,
  buildToolCapabilityViews,
} from '../utils/runWorkbenchProjection';

function statusToTaskStatus(status: string): TaskRecord['status'] {
  if (status === 'running' || status === 'queued' || status === 'paused') return 'in_progress';
  if (status === 'error') return 'blocked';
  return 'pending';
}

export function buildGlobalTaskRecords(args: {
  currentSessionId: string | null;
  sessionStates: ReturnType<typeof useTaskStore.getState>['sessionStates'];
}): TaskRecord[] {
  return Object.entries(args.sessionStates)
    .filter(([sessionId, state]) => (
      sessionId !== args.currentSessionId
      && (state.status === 'running' || state.status === 'queued' || state.status === 'paused' || state.status === 'error')
    ))
    .map(([sessionId, state]) => ({
      id: `global:${sessionId}`,
      scope: 'global' as const,
      title: `会话 ${sessionId.slice(0, 8)}`,
      status: statusToTaskStatus(state.status),
      steps: [{
        title: state.status === 'queued' && state.queuePosition !== undefined
          ? `队列 #${state.queuePosition}`
          : state.status,
        status: statusToTaskStatus(state.status),
      }],
      ownerRunId: null,
      sourceThreadId: sessionId,
      resumeHint: state.error,
    }));
}

function cronExecutionToTaskStatus(execution: CronJobExecution | null | undefined, enabled: boolean): TaskRecord['status'] {
  if (execution?.status === 'running' || execution?.status === 'pending') return 'in_progress';
  if (execution?.status === 'failed') return 'blocked';
  if (execution?.status === 'cancelled') return 'cancelled';
  return enabled ? 'pending' : 'completed';
}

function formatCronSchedule(job: CronJobDefinition): string {
  if (job.schedule.type === 'at') {
    return `一次性 · ${new Date(job.schedule.datetime).toLocaleString('zh-CN')}`;
  }
  if (job.schedule.type === 'every') {
    return `每 ${job.schedule.interval} ${job.schedule.unit}`;
  }
  return job.schedule.timezone
    ? `${job.schedule.expression} · ${job.schedule.timezone}`
    : job.schedule.expression;
}

function buildScheduledTaskRecords(args: {
  jobs: CronJobDefinition[];
  latestExecutions: Record<string, CronJobExecution | null>;
}): TaskRecord[] {
  return args.jobs.slice(0, 8).map((job) => {
    const latest = args.latestExecutions[job.id] ?? null;
    const status = cronExecutionToTaskStatus(latest, job.enabled);
    return {
      id: `scheduled:${job.id}`,
      scope: 'scheduled' as const,
      title: job.name,
      status,
      steps: [
        {
          title: formatCronSchedule(job),
          status: job.enabled ? 'pending' : 'completed',
        },
        ...(latest ? [{
          title: latest.status,
          status: cronExecutionToTaskStatus(latest, job.enabled),
        }] : []),
      ],
      resumeHint: latest?.error || (job.enabled ? undefined : '已停用'),
    };
  });
}

function backgroundTaskStatusToTaskStatus(status: Task['status']): TaskRecord['status'] {
  if (status === 'running' || status === 'queued' || status === 'paused' || status === 'waiting_input' || status === 'stalled') {
    return 'in_progress';
  }
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed' || status === 'expired' || status === 'orphaned') return 'blocked';
  return 'pending';
}

function backgroundTaskStatusLabel(task: Task): string {
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
      return '执行失败';
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

function workflowStatusToTaskStatus(status: ScriptRunSnapshot['status']): TaskRecord['status'] {
  return longTaskUiStatusToTaskStatus(normalizeLongTaskStatus(status));
}

function longTaskUiStatusToTaskStatus(status: LongTaskUiStatus): TaskRecord['status'] {
  if (status === 'queued' || status === 'running' || status === 'waiting_approval' || status === 'paused') {
    return 'in_progress';
  }
  if (status === 'completed') return 'done';
  return 'blocked';
}

function workflowStatusLabel(snapshot: ScriptRunSnapshot): string {
  const status = normalizeLongTaskStatus(snapshot.status);
  switch (status) {
    case 'running':
      return snapshot.currentPhase ? `执行中：${snapshot.currentPhase}` : '执行中';
    default:
      return getLongTaskStatusLabel(status);
  }
}

export function buildWorkflowTaskRecord(snapshot: ScriptRunSnapshot | undefined): TaskRecord | null {
  if (!snapshot) return null;
  const status = workflowStatusToTaskStatus(snapshot.status);
  const agentSummary = [
    snapshot.runningCount > 0 ? `${snapshot.runningCount} ${getLongTaskStatusLabel('running')}` : null,
    snapshot.doneCount > 0 ? `${snapshot.doneCount} ${getLongTaskStatusLabel('completed')}` : null,
    snapshot.errorCount > 0 ? `${snapshot.errorCount} ${getLongTaskStatusLabel('failed')}` : null,
  ].filter(Boolean).join(' · ');

  return {
    id: `workflow:${snapshot.runId}`,
    scope: 'session',
    title: snapshot.goal ? `Workflow: ${snapshot.goal}` : 'Workflow run',
    status,
    steps: [
      {
        title: workflowStatusLabel(snapshot),
        status,
      },
      ...(agentSummary ? [{
        title: agentSummary,
        status,
      }] : []),
    ],
    ownerRunId: snapshot.runId,
    sourceThreadId: snapshot.sessionId ?? null,
    resumeHint: snapshot.error,
    outputRefs: [{
      id: `workflow:${snapshot.runId}:replay`,
      type: 'replay',
      label: 'Workflow replay',
    }],
  };
}

function workflowAgentStatus(agent: ScriptRunAgentSnapshot): LongTaskUiStatus {
  return normalizeLongTaskStatus(agent.status);
}

export function buildWorkflowSubagentViews(snapshot: ScriptRunSnapshot | undefined): SubagentRunView[] {
  if (!snapshot) return [];
  return snapshot.agents.map((agent) => ({
    id: `workflow:${snapshot.runId}:${agent.id}`,
    parentRunId: snapshot.runId,
    role: agent.label || 'workflow agent',
    status: workflowAgentStatus(agent),
    inputSummary: agent.promptPreview || agent.phase || snapshot.goal || 'workflow agent',
    lastOutput: agent.resultPreview || agent.error || '',
    resultSummary: agent.resultPreview,
    handoff: agent.error,
  }));
}

function formatBackgroundTaskDuration(durationMs?: number): string | null {
  if (!durationMs || durationMs < 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function stringFromMetadata(metadata: Task['metadata'], key: string): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lastPathSegment(value: string | undefined): string | null {
  if (!value) return null;
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function outputRefTypeLabel(type: string): string {
  switch (type) {
    case 'log':
      return '运行日志';
    case 'text':
      return '最终输出';
    case 'report':
      return '报告';
    case 'trace':
      return 'Trace';
    case 'replay':
      return 'Replay';
    case 'url':
      return '链接';
    case 'file':
    case 'artifact':
      return '产物';
    default:
      return '输出';
  }
}

function buildTaskOutputRefs(task: Task): TaskRecordOutputRef[] {
  const refs = task.outputRefs
    .map((ref): TaskRecordOutputRef => {
      const pathOrUrl = ref.path || ref.uri || undefined;
      const fallbackLabel = lastPathSegment(pathOrUrl) || outputRefTypeLabel(ref.type);
      return {
        id: ref.id,
        type: ref.type,
        label: ref.label || fallbackLabel,
        pathOrUrl,
      };
    })
    .filter((ref) => ref.label || ref.pathOrUrl);

  const metadataLogPath = stringFromMetadata(task.metadata, 'logPath');
  if (metadataLogPath && !refs.some((ref) => ref.type === 'log' && ref.pathOrUrl === metadataLogPath)) {
    refs.unshift({
      id: `${task.id}:metadata-log`,
      type: 'log',
      label: outputRefTypeLabel('log'),
      pathOrUrl: metadataLogPath,
    });
  }

  return refs.slice(0, 4);
}

function formatOutputRefStep(ref: TaskRecordOutputRef): string {
  const name = lastPathSegment(ref.pathOrUrl) || ref.label;
  const label = ref.label || outputRefTypeLabel(ref.type);
  return name && name !== label ? `${label}：${name}` : label;
}

function backgroundTaskResumeHint(task: Task, outputRefs: TaskRecordOutputRef[]): string | undefined {
  if (task.failure?.message) return task.failure.message;
  if (task.status === 'stalled' && task.progress?.label) return task.progress.label;

  const finalRef = outputRefs.find((ref) => ref.type === 'text' || ref.type === 'report' || ref.type === 'artifact' || ref.type === 'file');
  if (finalRef) {
    const name = lastPathSegment(finalRef.pathOrUrl) || finalRef.label;
    return `最终输出：${name}`;
  }

  const logRef = outputRefs.find((ref) => ref.type === 'log');
  if (logRef && (task.status === 'running' || task.status === 'stalled')) {
    const name = lastPathSegment(logRef.pathOrUrl) || logRef.label;
    return `日志：${name}`;
  }

  return task.summary;
}

export function buildLedgerTaskRecords(tasks: Task[]): TaskRecord[] {
  return tasks
    .slice(0, 8)
    .map((task) => {
      const status = backgroundTaskStatusToTaskStatus(task.status);
      const outputRefs = buildTaskOutputRefs(task);
      const duration = formatBackgroundTaskDuration(task.durationMs);
      return {
        id: `background:${task.id}`,
        scope: 'global' as const,
        title: task.title,
        status,
        steps: [
          {
            title: backgroundTaskStatusLabel(task),
            status,
          },
          ...(duration ? [{
            title: duration,
            status,
          }] : []),
          ...outputRefs.map((ref) => ({
            title: formatOutputRefStep(ref),
            status,
          })),
        ],
        ownerRunId: task.runId ?? null,
        sourceThreadId: task.sessionId ?? null,
        resumeHint: backgroundTaskResumeHint(task, outputRefs),
        outputRefs,
      };
    });
}

function buildSubagentViews(args: {
  runId: string | null;
  agents: ReturnType<typeof useSwarmStore.getState>['agents'];
  selectedAgentId: string | null;
}): SubagentRunView[] {
  return args.agents.map((agent) => {
    const status = normalizeLongTaskStatus(agent.status || 'idle');
    return {
      id: agent.id,
      parentRunId: args.runId,
      role: agent.name || agent.role || 'Agent',
      status,
      inputSummary: agent.role || '等待任务',
      lastOutput: agent.lastReport || (agent.id === args.selectedAgentId ? '当前选中' : ''),
      resultSummary: agent.resultPreview,
      handoff: agent.error,
    };
  });
}

export function useRunWorkbenchModel(): RunWorkbenchModel {
  const projection = useCurrentTurnExecutionProjection();
  const statusRail = useStatusRailModel();
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionStates = useTaskStore((state) => state.sessionStates);
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const pendingPermissionRequest = useAppStore((state) => state.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((state) => state.pendingPermissionSessionId);
  const agents = useSwarmStore((state) => state.agents);
  const selectedSwarmAgentId = useAppStore((state) => state.selectedSwarmAgentId);
  const cronJobs = useCronStore((state) => state.jobs);
  const cronLatestExecutions = useCronStore((state) => state.latestExecutions);
  const backgroundTasks = useBackgroundTaskStore((state) => state.tasks);
  const workflowSnapshot = useWorkflowStore((state) => state.activeSnapshot(currentSessionId ?? undefined));
  const sessionTasks = useSessionStore((state) => state.sessionTasks);

  const taskProgress = currentSessionId ? sessionTaskProgress[currentSessionId] ?? null : null;
  const sessionStatus = currentSessionId ? sessionStates[currentSessionId]?.status ?? null : null;
  const pendingApprovalId = pendingPermissionSessionId === currentSessionId
    ? pendingPermissionRequest?.id ?? null
    : null;

  return useMemo(() => {
    const run = buildRunUiState({
      projection,
      sessionId: currentSessionId,
      sessionStatus,
      taskProgress,
      todos: statusRail.todos.items,
      pendingApprovalId,
    });
    const sessionTask = buildSessionTaskRecord({
      sessionId: currentSessionId,
      runId: run.identity.runId,
      runStatus: run.status,
      sessionTasks,
      todos: statusRail.todos.items,
      taskProgress,
    });
    const globalTasks = buildGlobalTaskRecords({
      currentSessionId,
      sessionStates,
    });
    const scheduledTasks = buildScheduledTaskRecords({
      jobs: cronJobs,
      latestExecutions: cronLatestExecutions,
    });
    const ledgerTasks = buildLedgerTaskRecords(backgroundTasks);
    const workflowTask = buildWorkflowTaskRecord(workflowSnapshot);
    const workflowSubagents = buildWorkflowSubagentViews(workflowSnapshot);

    return {
      run,
      loopDecisions: buildLoopDecisionViews(projection),
      tools: buildToolCapabilityViews(projection),
      tasks: [
        ...(sessionTask ? [sessionTask] : []),
        ...(workflowTask ? [workflowTask] : []),
        ...globalTasks,
        ...ledgerTasks,
        ...scheduledTasks,
      ],
      subagents: buildSubagentViews({
        runId: run.identity.runId,
        agents,
        selectedAgentId: selectedSwarmAgentId,
      }).concat(workflowSubagents),
      memoryActivities: buildMemoryActivityEvents(projection),
      outputs: buildOutputArtifactViews(projection),
    };
  }, [
    agents,
    backgroundTasks,
    cronJobs,
    cronLatestExecutions,
    currentSessionId,
    pendingApprovalId,
    projection,
    selectedSwarmAgentId,
    sessionStates,
    sessionStatus,
    sessionTasks,
    statusRail.todos.items,
    taskProgress,
    workflowSnapshot,
  ]);
}
