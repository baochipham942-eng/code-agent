import { useMemo } from 'react';
import type { AgentTreeSnapshot } from '@shared/contract/agentTree';
import type { TaskProgressData } from '@shared/contract';
import type { RunUiStatus } from '../types/runWorkbench';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useAgentTreeSnapshot } from './useAgentTreeSnapshot';
import { useRunWorkbenchModel } from './useRunWorkbenchModel';

const LIVE_RUN_STATUSES: ReadonlySet<RunUiStatus> = new Set([
  'planning',
  'running',
  'using_tools',
  'verifying',
  'waiting_approval',
]);

export interface TaskActivitySignals {
  agentNodeCount: number;
  taskCount: number;
  taskProgress: TaskProgressData | null;
  runStatus: RunUiStatus;
}

export function deriveHasTaskActivity(signals: TaskActivitySignals): boolean {
  return signals.agentNodeCount > 0
    || signals.taskCount > 0
    || Boolean(signals.taskProgress)
    || LIVE_RUN_STATUSES.has(signals.runStatus);
}

export interface TaskActivity {
  hasTaskActivity: boolean;
  agentTreeSnapshot: AgentTreeSnapshot | null;
}

export function useTaskActivity(): TaskActivity {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const runWorkbench = useRunWorkbenchModel();
  const { snapshot: agentTreeSnapshot } = useAgentTreeSnapshot(currentSessionId);
  const taskProgress = currentSessionId
    ? sessionTaskProgress[currentSessionId] ?? null
    : null;

  return useMemo(() => ({
    hasTaskActivity: deriveHasTaskActivity({
      agentNodeCount: agentTreeSnapshot?.nodes.length ?? 0,
      taskCount: runWorkbench.tasks.length,
      taskProgress,
      runStatus: runWorkbench.run.status,
    }),
    agentTreeSnapshot,
  }), [agentTreeSnapshot, runWorkbench.run.status, runWorkbench.tasks.length, taskProgress]);
}
