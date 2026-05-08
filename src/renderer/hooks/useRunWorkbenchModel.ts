import { useMemo } from 'react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSwarmStore } from '../stores/swarmStore';
import { useTaskStore } from '../stores/taskStore';
import { useCronStore } from '../stores/cronStore';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';
import { useStatusRailModel } from './useStatusRailModel';
import type { RunWorkbenchModel, SubagentRunView, TaskRecord } from '../types/runWorkbench';
import type { CronJobDefinition, CronJobExecution } from '@shared/contract';
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

function buildGlobalTaskRecords(args: {
  currentSessionId: string | null;
  sessionStates: ReturnType<typeof useTaskStore.getState>['sessionStates'];
  runId: string | null;
}): TaskRecord[] {
  return Object.entries(args.sessionStates)
    .filter(([, state]) => state.status === 'running' || state.status === 'queued' || state.status === 'paused' || state.status === 'error')
    .map(([sessionId, state]) => ({
      id: `global:${sessionId}`,
      scope: 'global' as const,
      title: sessionId === args.currentSessionId ? '当前会话运行' : `会话 ${sessionId.slice(0, 8)}`,
      status: statusToTaskStatus(state.status),
      steps: [{
        title: state.status === 'queued' && state.queuePosition !== undefined
          ? `队列 #${state.queuePosition}`
          : state.status,
        status: statusToTaskStatus(state.status),
      }],
      ownerRunId: sessionId === args.currentSessionId ? args.runId : null,
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
      runId: run.identity.runId,
    });
    const scheduledTasks = buildScheduledTaskRecords({
      jobs: cronJobs,
      latestExecutions: cronLatestExecutions,
    });

    return {
      run,
      loopDecisions: buildLoopDecisionViews(projection),
      tools: buildToolCapabilityViews(projection),
      tasks: [
        ...(sessionTask ? [sessionTask] : []),
        ...globalTasks,
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
