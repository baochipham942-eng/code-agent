import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useTaskStore } from '../stores/taskStore';
import { useCronStore } from '../stores/cronStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';
import { useStatusRailModel } from './useStatusRailModel';
import type { RunWorkbenchModel, SubagentRunView, TaskRecord } from '../types/runWorkbench';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
import type { Task } from '@shared/contract/backgroundTask';
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
  return enabled ? 'pending' : 'done';
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
          status: job.enabled ? 'pending' : 'done',
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
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled' || status === 'expired' || status === 'orphaned') return 'blocked';
  return 'pending';
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

function buildLedgerTaskRecords(tasks: Task[]): TaskRecord[] {
  return tasks
    .slice(0, 8)
    .map((task) => {
      const status = backgroundTaskStatusToTaskStatus(task.status);
      const logRef = task.outputRefs.find((ref) => ref.type === 'log' || ref.path || ref.uri);
      const duration = formatBackgroundTaskDuration(task.durationMs);
      return {
        id: `background:${task.id}`,
        scope: 'global' as const,
        title: task.title,
        status,
        steps: [
          {
            title: task.status,
            status,
          },
          ...(duration ? [{
            title: duration,
            status,
          }] : []),
          ...(logRef ? [{
            title: logRef.path || logRef.uri || logRef.label || '输出日志',
            status,
          }] : []),
        ],
        ownerRunId: task.runId ?? null,
        sourceThreadId: task.sessionId ?? null,
        resumeHint: task.failure?.message || task.summary,
      };
    });
}

function buildSubagentViews(args: {
  runId: string | null;
  agents: ReturnType<typeof useSwarmStore.getState>['agents'];
  selectedAgentId: string | null;
}): SubagentRunView[] {
  return args.agents.map((agent) => {
    const status = agent.status || 'idle';
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

    return {
      run,
      loopDecisions: buildLoopDecisionViews(projection),
      tools: buildToolCapabilityViews(projection),
      tasks: [
        ...(sessionTask ? [sessionTask] : []),
        ...globalTasks,
        ...ledgerTasks,
        ...scheduledTasks,
      ],
      subagents: buildSubagentViews({
        runId: run.identity.runId,
        agents,
        selectedAgentId: selectedSwarmAgentId,
      }),
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
    statusRail.todos.items,
    taskProgress,
  ]);
}
