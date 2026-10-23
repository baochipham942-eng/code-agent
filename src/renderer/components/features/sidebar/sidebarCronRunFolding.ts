import type { CronTaskRunAggregate } from '../../../hooks/useCronRunGroups';

interface SidebarCronRunSession {
  id: string;
  origin?: {
    kind?: string;
    id?: string;
  };
}

interface SidebarCronRunFoldingInput {
  session: SidebarCronRunSession;
  aggregate?: CronTaskRunAggregate;
  currentSessionId: string | null;
  hasSearchFilters: boolean;
  expanded: boolean;
}

interface SidebarCronRunFoldingDecision {
  taskId?: string;
  isLatest: boolean;
  shouldHide: boolean;
}

export function getSidebarCronTaskId(session: SidebarCronRunSession): string | undefined {
  if (session.origin?.kind !== 'cron' && session.origin?.kind !== 'heartbeat') return undefined;
  const taskId = session.origin.id?.trim();
  return taskId || undefined;
}

function getSidebarCronRunFoldingDecision({
  session,
  aggregate,
  currentSessionId,
  hasSearchFilters,
  expanded,
}: SidebarCronRunFoldingInput): SidebarCronRunFoldingDecision {
  const taskId = getSidebarCronTaskId(session);
  const isLatest = aggregate?.latestSessionId === session.id;
  const canFold = Boolean(taskId && aggregate && aggregate.runCount > 1 && !hasSearchFilters && !isLatest);
  return {
    ...(taskId ? { taskId } : {}),
    isLatest,
    // 展开时旧运行从原时间位置拿掉，改挂到该任务最新一行下面。
    // 收起时当前正在看的那次旧运行仍留在原位，避免把打开的会话藏掉。
    shouldHide: Boolean(canFold && (expanded || currentSessionId !== session.id)),
  };
}

interface SidebarCronVisibleRow<T> {
  session: T;
  indented: boolean;
}

/**
 * Flat cap still applies to the chronological rows. Expanding a task inserts
 * that task's older runs directly under its latest row and does not uncap
 * the rest of the group.
 */
export function assembleSidebarCronRows<T extends SidebarCronRunSession & { id: string; updatedAt: number }>(args: {
  sessions: readonly T[];
  aggregatesByTaskId: Record<string, { runCount: number; latestSessionId: string } | undefined> | undefined;
  expandedTaskIds: ReadonlySet<string>;
  currentSessionId: string | null;
  hasSearchFilters: boolean;
  rowCap: number;
  showAllRows: boolean;
}): Array<SidebarCronVisibleRow<T>> {
  const flat: T[] = [];
  for (const session of args.sessions) {
    const taskId = getSidebarCronTaskId(session);
    const aggregate = taskId ? args.aggregatesByTaskId?.[taskId] : undefined;
    const decision = getSidebarCronRunFoldingDecision({
      session,
      aggregate,
      currentSessionId: args.currentSessionId,
      hasSearchFilters: args.hasSearchFilters,
      expanded: Boolean(taskId && args.expandedTaskIds.has(taskId)),
    });
    if (!decision.shouldHide) flat.push(session);
  }
  const currentIndex = flat.findIndex((session) => session.id === args.currentSessionId);
  // 当前会话是展开任务的旧运行时已不在 flat 里（缩进挂到该任务最新行下），
  // cap 的保护点改落在那条最新行上；否则回落 rowCap 会把最新行连同
  // 缩进旧行（含当前会话）和 xN 开关一起截掉。
  let anchorIndex = currentIndex;
  if (anchorIndex === -1 && args.currentSessionId) {
    const currentSession = args.sessions.find((session) => session.id === args.currentSessionId);
    const currentTaskId = currentSession ? getSidebarCronTaskId(currentSession) : undefined;
    const latestSessionId = currentTaskId && args.expandedTaskIds.has(currentTaskId)
      ? args.aggregatesByTaskId?.[currentTaskId]?.latestSessionId
      : undefined;
    if (latestSessionId) anchorIndex = flat.findIndex((session) => session.id === latestSessionId);
  }
  const cap = args.hasSearchFilters || args.showAllRows
    ? flat.length
    : Math.max(args.rowCap, anchorIndex + 1);
  const rows: Array<SidebarCronVisibleRow<T>> = [];
  for (const session of flat.slice(0, cap)) {
    rows.push({ session, indented: false });
    const taskId = getSidebarCronTaskId(session);
    if (!taskId || args.hasSearchFilters || !args.expandedTaskIds.has(taskId)) continue;
    const aggregate = args.aggregatesByTaskId?.[taskId];
    if (aggregate?.latestSessionId !== session.id) continue;
    const older = args.sessions
      .filter((candidate) => candidate.id !== session.id && getSidebarCronTaskId(candidate) === taskId)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt || 0);
    for (const run of older) rows.push({ session: run, indented: true });
  }
  return rows;
}
