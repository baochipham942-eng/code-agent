import type { CronTaskRunAggregate } from '../../../hooks/useCronRunGroups';

export interface SidebarCronRunSession {
  id: string;
  origin?: {
    kind?: string;
    id?: string;
  };
}

export interface SidebarCronRunFoldingInput {
  session: SidebarCronRunSession;
  aggregate?: CronTaskRunAggregate;
  currentSessionId: string | null;
  hasSearchFilters: boolean;
  expanded: boolean;
}

export interface SidebarCronRunFoldingDecision {
  taskId?: string;
  isLatest: boolean;
  shouldHide: boolean;
}

export function getSidebarCronTaskId(session: SidebarCronRunSession): string | undefined {
  if (session.origin?.kind !== 'cron' && session.origin?.kind !== 'heartbeat') return undefined;
  const taskId = session.origin.id?.trim();
  return taskId || undefined;
}

export function getSidebarCronRunFoldingDecision({
  session,
  aggregate,
  currentSessionId,
  hasSearchFilters,
  expanded,
}: SidebarCronRunFoldingInput): SidebarCronRunFoldingDecision {
  const taskId = getSidebarCronTaskId(session);
  const isLatest = aggregate?.latestSessionId === session.id;
  const canFold = Boolean(taskId && aggregate && aggregate.runCount > 1 && !hasSearchFilters && !expanded);
  return {
    ...(taskId ? { taskId } : {}),
    isLatest,
    shouldHide: Boolean(canFold && !isLatest && currentSessionId !== session.id),
  };
}
