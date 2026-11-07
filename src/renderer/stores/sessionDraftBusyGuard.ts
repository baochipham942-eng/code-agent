import type { Message } from '@shared/contract';
import { useAppStore } from './appStore';
import { useTaskStore } from './taskStore';

/** 复用判定需要的最小会话视图（由 sessionStore 状态切片提供，避免循环依赖）。 */
export interface DraftBusySignals {
  runningSessionIds?: Set<string>;
  sessionRuntimes?: Map<string, { activeAgentCount?: number }>;
  pendingUserQuestionsBySessionId?: Map<string, unknown[]>;
}

/**
 * 会话是否「忙」：在跑、挂着审批/提问、或有后台 agent。
 * 这类会话即使列表元数据仍显示 新对话/0 消息，也绝不能被「新任务」当作空白草稿复用，
 * 否则下一个问题会落进旧会话。
 */
function isSessionBusyForDraftReuse(sessionId: string, slice: DraftBusySignals): boolean {
  const app = useAppStore.getState();
  if (slice.runningSessionIds?.has(sessionId) || app.isSessionProcessing(sessionId)) return true;
  if ((slice.sessionRuntimes?.get(sessionId)?.activeAgentCount ?? 0) > 0) return true;
  if (app.pendingPermissionSessionId === sessionId && app.pendingPermissionRequest) return true;
  if ((app.queuedPermissionRequests?.[sessionId]?.length ?? 0) > 0) return true;
  if ((slice.pendingUserQuestionsBySessionId?.get(sessionId)?.length ?? 0) > 0) return true;
  const taskStatus = useTaskStore.getState().sessionStates[sessionId]?.status;
  return taskStatus === 'running' || taskStatus === 'queued' || taskStatus === 'cancelling';
}

/**
 * 从候选列表里剔除不能当草稿复用的会话：忙碌会话，以及已有可见消息
 * （含首条乐观消息）的当前会话。
 */
export function excludeBusySessions<T extends { id: string }>(
  sessions: T[],
  currentSessionId: string | null,
  messages: Message[],
  slice: DraftBusySignals,
): T[] {
  const currentHasContent = messages.some((m) => !m.isMeta);
  return sessions.filter((s) => {
    if (isSessionBusyForDraftReuse(s.id, slice)) return false;
    return !(s.id === currentSessionId && currentHasContent);
  });
}
