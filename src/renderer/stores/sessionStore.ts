import { create } from 'zustand';
import type { Session, Message, TodoItem, StreamRecoverySnapshot } from '@shared/contract';
import type { AgentEngineSessionMetadata } from '@shared/contract/agentEngine';
import { normalizeAgentEngineSession } from '@shared/contract/agentEngine';
import type { DesignBrief } from '@shared/contract/designBrief';
import { deriveSessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import type { ContextHealthState } from '@shared/contract/contextHealth';
import { IPC_CHANNELS, IPC_DOMAINS, type SessionStatusUpdateEvent, type SessionRuntimeSummary } from '@shared/ipc';
import { useStatusStore } from './statusStore';
import type { BackgroundTaskInfo, BackgroundTaskUpdateEvent } from '@shared/contract/sessionState';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';
import { useSessionUIStore } from './sessionUIStore';
import { useAppStore } from './appStore';
import { useAppshotsStore } from './appshotsStore';

const logger = createLogger('SessionStore');

async function invokeSession<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.SESSION, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Session action failed: ${action}`);
  }
  return response.data as T;
}

async function invokeAgentEngine<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.AGENT_ENGINE, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Agent Engine action failed: ${action}`);
  }
  return response.data as T;
}

// switchSession 竞态保护计数器
let _switchCounter = 0;

function invalidatePendingSessionSwitches(): void {
  _switchCounter += 1;
}

function hydrateToolCallResults(messages: Message[]): Message[] {
  const resultsByToolCallId = new Map<string, NonNullable<Message['toolResults']>[number]>();

  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result.toolCallId) {
        resultsByToolCallId.set(result.toolCallId, result);
      }
    }
  }

  if (resultsByToolCallId.size === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (!message.toolCalls?.length) {
      return message;
    }

    let changed = false;
    const toolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.result) {
        return toolCall;
      }
      const result = resultsByToolCallId.get(toolCall.id);
      if (!result) {
        return toolCall;
      }
      changed = true;
      return { ...toolCall, result };
    });

    return changed ? { ...message, toolCalls } : message;
  });
}

async function refreshContextHealthForSession(sessionId: string, switchVersion: number): Promise<void> {
  try {
    const health = await ipcService.invoke(IPC_CHANNELS.CONTEXT_HEALTH_GET, sessionId) as ContextHealthState | null;
    if (switchVersion !== _switchCounter || useSessionStore.getState().currentSessionId !== sessionId) {
      return;
    }
    useAppStore.getState().setContextHealth(health ?? null);
  } catch (error) {
    logger.warn('Failed to refresh context health for session', { sessionId, error });
    if (switchVersion === _switchCounter && useSessionStore.getState().currentSessionId === sessionId) {
      useAppStore.getState().setContextHealth(null);
    }
  }
}

function shouldReplaceContextHealth(
  next: ContextHealthState | null | undefined,
  previous: ContextHealthState | null | undefined,
): boolean {
  if (!previous) {
    return true;
  }
  if (!next) {
    return false;
  }
  if (next.currentTokens > 0) {
    return true;
  }
  return previous.currentTokens <= 0;
}

export interface SessionWithMeta extends Session {
  messageCount: number;
  turnCount: number;
}

function normalizeSession(session: Session & {
  messageCount?: number;
  turnCount?: number;
}): SessionWithMeta {
  return {
    ...session,
    title: session.title || '未命名会话',
    type: session.type || 'chat',
    engine: normalizeAgentEngineSession(session.engine),
    updatedAt: Number.isFinite(session.updatedAt) ? session.updatedAt : (Number.isFinite(session.createdAt) ? session.createdAt : Date.now()),
    createdAt: Number.isFinite(session.createdAt) ? session.createdAt : Date.now(),
    messageCount: session.messageCount || 0,
    turnCount: session.turnCount || 0,
    workbenchSnapshot: session.workbenchSnapshot || deriveSessionWorkbenchSnapshot([], {
      workingDirectory: session.workingDirectory ?? null,
    }),
  };
}

function deriveCurrentSessionMeta(session: SessionWithMeta, messages: Message[]): SessionWithMeta {
  const nextTurnCount = messages.filter((message) => message.role === 'user').length;
  return {
    ...session,
    messageCount: Math.max(session.messageCount, messages.length),
    turnCount: Math.max(session.turnCount, nextTurnCount),
    workbenchSnapshot: deriveSessionWorkbenchSnapshot(messages, {
      workingDirectory: session.workingDirectory ?? null,
    }),
  };
}

export type SessionFilter = 'active' | 'archived' | 'all';

interface CreateSessionOptions {
  workingDirectory?: string | null;
  engine?: Partial<AgentEngineSessionMetadata> | null;
}

function normalizeDraftDirectory(value?: string | null): string {
  return value?.trim() ?? '';
}

function isUntouchedNewSession(
  session: Pick<SessionWithMeta, 'title' | 'messageCount' | 'turnCount' | 'isArchived' | 'workingDirectory' | 'status'>,
  workingDirectory?: string | null,
): boolean {
  if (session.isArchived || session.status === 'archived') {
    return false;
  }
  if ((session.title || '').trim() !== '新对话') {
    return false;
  }
  if ((session.messageCount ?? 0) > 0 || (session.turnCount ?? 0) > 0) {
    return false;
  }
  return normalizeDraftDirectory(session.workingDirectory) === normalizeDraftDirectory(workingDirectory);
}

export function findReusableNewSessionDraft(params: {
  sessions: SessionWithMeta[];
  currentSessionId: string | null;
  messages: Message[];
  todos: TodoItem[];
  workingDirectory?: string | null;
}): SessionWithMeta | null {
  const current = params.currentSessionId
    ? params.sessions.find((session) => session.id === params.currentSessionId) ?? null
    : null;
  if (
    current &&
    params.messages.length === 0 &&
    params.todos.length === 0 &&
    isUntouchedNewSession(current, params.workingDirectory)
  ) {
    return current;
  }

  return params.sessions.find((session) =>
    isUntouchedNewSession(session, params.workingDirectory)
  ) ?? null;
}

interface SessionState {
  sessions: SessionWithMeta[];
  currentSessionId: string | null;
  messages: Message[];
  todos: TodoItem[];
  streamSnapshot: StreamRecoverySnapshot | null;
  isLoading: boolean;
  error: string | null;
  unreadSessionIds: Set<string>;
  runningSessionIds: Set<string>;
  sessionRuntimes: Map<string, SessionRuntimeSummary>;
  backgroundTasks: BackgroundTaskInfo[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
  // 当前会话锁定的 design brief（来自 question-form 提交，仅运行时内存态，不进 DB）
  sessionDesignBriefs: Map<string, DesignBrief>;
}

interface SessionActions {
  loadSessions: () => Promise<void>;
  createSession: (title?: string, options?: CreateSessionOptions) => Promise<Session | null>;
  switchSession: (sessionId: string) => Promise<void>;
  refreshContextHealth: (sessionId?: string) => Promise<ContextHealthState | null>;
  deleteSession: (sessionId: string) => Promise<void>;
  archiveSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setMessages: (messages: Message[]) => void;
  setTodos: (todos: TodoItem[]) => void;
  loadOlderMessages: () => Promise<void>;
  clearCurrentSession: () => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionEngine: (sessionId: string, engine: Partial<AgentEngineSessionMetadata>) => Promise<void>;
  markSessionUnread: (sessionId: string) => void;
  markSessionRead: (sessionId: string) => void;
  isSessionUnread: (sessionId: string) => boolean;
  updateSessionRuntime: (event: SessionStatusUpdateEvent) => void;
  isSessionRunning: (sessionId: string) => boolean;
  getRunningSessionCount: () => number;
  moveToBackground: (sessionId: string) => Promise<boolean>;
  moveToForeground: (sessionId: string) => Promise<void>;
  updateBackgroundTask: (event: BackgroundTaskUpdateEvent) => void;
  getBackgroundTaskCount: () => number;
  renameSession: (id: string, title: string) => Promise<void>;
  setSessionDesignBrief: (sessionId: string, brief: DesignBrief) => void;
  clearSessionDesignBrief: (sessionId: string) => void;
  getSessionDesignBrief: (sessionId: string) => DesignBrief | undefined;
}

type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()((set, get) => ({
    sessions: [],
    currentSessionId: null,
    messages: [],
    todos: [],
    streamSnapshot: null,
    isLoading: false,
    error: null,
    unreadSessionIds: new Set<string>(),
    runningSessionIds: new Set<string>(),
    sessionRuntimes: new Map<string, SessionRuntimeSummary>(),
    backgroundTasks: [],
    hasOlderMessages: false,
    isLoadingOlder: false,
    sessionDesignBriefs: new Map<string, DesignBrief>(),

    loadSessions: async () => {
      const { filter } = useSessionUIStore.getState();
      set({ isLoading: true, error: null });
      try {
        const includeArchived = filter === 'archived' || filter === 'all';
        const sessions = await invokeSession<Session[]>('list', { includeArchived });

        let sessionsWithMeta: SessionWithMeta[] = (sessions || []).map((session) =>
          normalizeSession(session as Session & { messageCount?: number; turnCount?: number })
        );

        if (filter === 'active') {
          sessionsWithMeta = sessionsWithMeta.filter(s => !s.isArchived);
        } else if (filter === 'archived') {
          sessionsWithMeta = sessionsWithMeta.filter(s => s.isArchived);
        }

        set({ sessions: sessionsWithMeta, isLoading: false });
      } catch (error) {
        logger.error('Failed to load sessions', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to load sessions',
          isLoading: false
        });
      }
    },

    createSession: async (title?: string, options?: CreateSessionOptions) => {
      try {
        const inheritedWorkingDirectory =
          options?.workingDirectory !== undefined
            ? options.workingDirectory
            : useAppStore.getState().workingDirectory;
        const nextTitle = title?.trim() || '新对话';
        if (nextTitle === '新对话') {
          useAppshotsStore.getState().clear();
          const reusableSession = findReusableNewSessionDraft({
            sessions: get().sessions,
            currentSessionId: get().currentSessionId,
            messages: get().messages,
            todos: get().todos,
            workingDirectory: inheritedWorkingDirectory,
          });
          if (reusableSession) {
            if (get().currentSessionId !== reusableSession.id) {
              await get().switchSession(reusableSession.id);
            }
            useAppStore.getState().setWorkingDirectory(reusableSession.workingDirectory ?? null);
            set({ isLoading: false, error: null });
            return reusableSession;
          }
        }

        set({ isLoading: true, error: null });
        const session = await invokeSession<Session | null>('create', {
          title: nextTitle,
          workingDirectory: inheritedWorkingDirectory,
          engine: options?.engine ?? null,
        });
        if (session) {
          const newSessionWithMeta: SessionWithMeta = normalizeSession({
            ...session,
            messageCount: 0,
            turnCount: 0,
          });
          invalidatePendingSessionSwitches();
          useAppStore.getState().setWorkingDirectory(newSessionWithMeta.workingDirectory ?? null);
          set((state) => ({
            sessions: [newSessionWithMeta, ...state.sessions],
            currentSessionId: session.id,
            messages: [],
            todos: [],
            streamSnapshot: null,
            hasOlderMessages: false,
            isLoadingOlder: false,
            isLoading: false,
          }));
          useAppStore.getState().setContextHealth(null);
          return session;
        }
        return null;
      } catch (error) {
        logger.error('Failed to create session', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to create session',
          isLoading: false
        });
        return null;
      }
    },

    switchSession: async (sessionId: string) => {
      const { currentSessionId, unreadSessionIds } = get();
      if (currentSessionId === sessionId) return;

      // 竞态保护：记录本次切换的版本号，异步完成后检查是否过期
      const switchVersion = ++_switchCounter;
      const previewSession = get().sessions.find((session) => session.id === sessionId) ?? null;
      const nextUnreadIds = new Set(unreadSessionIds);
      nextUnreadIds.delete(sessionId);

      useAppStore.getState().setContextHealth(null);
      useAppStore.getState().setWorkingDirectory(previewSession?.workingDirectory ?? null);
      set({
        currentSessionId: sessionId,
        messages: [],
        todos: [],
        streamSnapshot: null,
        hasOlderMessages: false,
        isLoadingOlder: false,
        unreadSessionIds: nextUnreadIds,
        isLoading: true,
        error: null,
      });
      try {
        const session = await invokeSession<Session & { messages?: Message[]; todos?: TodoItem[] } | null>('load', { sessionId });

        // 竞态检查：如果在等待期间又发起了新的切换，丢弃本次结果
        if (switchVersion !== _switchCounter || useSessionStore.getState().currentSessionId !== sessionId) {
          logger.debug('switchSession stale response discarded', { sessionId, switchVersion, current: _switchCounter });
          return;
        }

        if (session) {
          const normalizedSession = normalizeSession({
            ...session,
            messageCount: (session as SessionWithMeta).messageCount || session.messages?.length || 0,
            turnCount: session.turnCount || session.messages?.filter((message) => message.role === 'user').length || 0,
          });
          const loadedMessages = hydrateToolCallResults(session.messages || []);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): session 类型上没声明 messageCount，但 normalizeSession 已确保它存在，应在 Session/SessionWithMeta 类型中加上 messageCount?: number
          const totalCount = (session as any).messageCount ?? loadedMessages.length;
          useAppStore.getState().setWorkingDirectory(session.workingDirectory ?? null);
          set({
            currentSessionId: sessionId,
            messages: loadedMessages,
            todos: session.todos || [],
            streamSnapshot: session.streamSnapshot || null,
            isLoading: false,
            unreadSessionIds: nextUnreadIds,
            hasOlderMessages: totalCount > loadedMessages.length,
            isLoadingOlder: false,
            sessions: get().sessions.map((item) =>
              item.id === sessionId ? deriveCurrentSessionMeta(normalizedSession, loadedMessages) : item
            ),
          });
          await refreshContextHealthForSession(sessionId, switchVersion);
        } else {
          // 后端返回 null/undefined — 仍然切换到该会话（显示空状态）
          logger.warn('switchSession: backend returned null session', { sessionId });
          useAppStore.getState().setWorkingDirectory(null);
          set({
            currentSessionId: sessionId,
            messages: [],
            todos: [],
            streamSnapshot: null,
            isLoading: false,
          });
          useAppStore.getState().setContextHealth(null);
        }
      } catch (error) {
        logger.error('Failed to switch session', error);
        if (switchVersion === _switchCounter) {
          set({
            error: error instanceof Error ? error.message : 'Failed to switch session',
            isLoading: false
          });
        }
      }
    },

    refreshContextHealth: async (sessionId?: string) => {
      const targetSessionId = sessionId || get().currentSessionId;
      if (!targetSessionId) {
        return null;
      }

      try {
        const health = await ipcService.invoke(
          IPC_CHANNELS.CONTEXT_HEALTH_GET,
          targetSessionId,
        ) as ContextHealthState | null;

        if (get().currentSessionId === targetSessionId) {
          const appStore = useAppStore.getState();
          if (shouldReplaceContextHealth(health, appStore.contextHealth)) {
            appStore.setContextHealth(health ?? null);
          }
        }

        return health ?? null;
      } catch (error) {
        logger.warn('Failed to refresh context health for session', { sessionId: targetSessionId, error });
        return null;
      }
    },

    deleteSession: async (sessionId: string) => {
      try {
        await invokeSession('delete', { sessionId });

        const { currentSessionId, sessions } = get();
        const newSessions = sessions.filter((s) => s.id !== sessionId);

        if (currentSessionId === sessionId) {
          if (newSessions.length > 0) {
            set({ sessions: newSessions });
            await get().switchSession(newSessions[0].id);
          } else {
            set({ sessions: newSessions, currentSessionId: null, messages: [], streamSnapshot: null });
          }
        } else {
          set({ sessions: newSessions });
        }
      } catch (error) {
        logger.error('Failed to delete session', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to delete session',
        });
      }
    },

    archiveSession: async (sessionId: string) => {
      try {
        await invokeSession('archive', { sessionId });

        const { filter } = useSessionUIStore.getState();
        const { currentSessionId, sessions } = get();

        if (filter === 'active') {
          const newSessions = sessions.filter((s) => s.id !== sessionId);

          if (currentSessionId === sessionId) {
            if (newSessions.length > 0) {
              set({ sessions: newSessions });
              await get().switchSession(newSessions[0].id);
            } else {
              set({ sessions: newSessions, currentSessionId: null, messages: [], streamSnapshot: null });
            }
          } else {
            set({ sessions: newSessions });
          }
        } else {
          set({
            sessions: sessions.map((s) =>
              s.id === sessionId ? { ...s, isArchived: true, archivedAt: Date.now() } : s
            ),
          });
        }

        logger.info('Session archived', { sessionId });
      } catch (error) {
        logger.error('Failed to archive session', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to archive session',
        });
      }
    },

    unarchiveSession: async (sessionId: string) => {
      try {
        await invokeSession('unarchive', { sessionId });

        const { filter } = useSessionUIStore.getState();
        const { sessions } = get();

        if (filter === 'archived') {
          set({
            sessions: sessions.filter((s) => s.id !== sessionId),
          });
        } else {
          set({
            sessions: sessions.map((s) =>
              s.id === sessionId ? { ...s, isArchived: false, archivedAt: undefined } : s
            ),
          });
        }

        logger.info('Session unarchived', { sessionId });
      } catch (error) {
        logger.error('Failed to unarchive session', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to unarchive session',
        });
      }
    },

    addMessage: (message: Message) => {
      set((state) => ({
        messages: hydrateToolCallResults([...state.messages, message]),
        streamSnapshot: null,
      }));

      const { currentSessionId, sessions } = get();
      if (currentSessionId) {
        const nextMessages = [...get().messages];
        set({
          sessions: sessions.map((s) =>
            s.id === currentSessionId
              ? deriveCurrentSessionMeta({
                  ...s,
                  messageCount: s.messageCount + 1,
                  turnCount: message.role === 'user' ? s.turnCount + 1 : s.turnCount,
                  updatedAt: Date.now(),
                }, nextMessages)
              : s
          ),
        });
      }
    },

    updateMessage: (id: string, updates: Partial<Message>) => {
      set((state) => ({
        messages: state.messages.map((msg) =>
          msg.id === id ? { ...msg, ...updates } : msg
        ),
      }));

      const { currentSessionId, sessions, messages } = get();
      if (!currentSessionId) {
        return;
      }

      set({
        sessions: sessions.map((session) =>
          session.id === currentSessionId ? deriveCurrentSessionMeta(session, messages) : session
        ),
      });
    },

    setMessages: (messages: Message[]) => {
      const { currentSessionId, sessions } = get();
      const hydratedMessages = hydrateToolCallResults(messages);
      set({
        messages: hydratedMessages,
        sessions: currentSessionId
          ? sessions.map((session) =>
              session.id === currentSessionId ? deriveCurrentSessionMeta(session, hydratedMessages) : session
            )
          : sessions,
      });
    },

    setTodos: (todos: TodoItem[]) => {
      set({ todos });
    },

    loadOlderMessages: async () => {
      const { isLoadingOlder, hasOlderMessages, messages, currentSessionId } = get();
      if (isLoadingOlder || !hasOlderMessages || !currentSessionId || messages.length === 0) return;

      set({ isLoadingOlder: true });
      try {
        const oldestTimestamp = messages[0].timestamp;
        const result = await ipcService.invoke(IPC_CHANNELS.SESSION_LOAD_OLDER_MESSAGES, {
          sessionId: currentSessionId,
          beforeTimestamp: oldestTimestamp,
          limit: 30,
        });
        if (result && result.messages && result.messages.length > 0) {
          const olderMessages = result.messages as Message[];
          const hasMore = result.hasMore;
          set(state => ({
            messages: hydrateToolCallResults([...olderMessages, ...state.messages]),
            hasOlderMessages: hasMore,
            isLoadingOlder: false,
          }));
        } else {
          set({ hasOlderMessages: false, isLoadingOlder: false });
        }
      } catch (error) {
        console.error('Failed to load older messages:', error);
        set({ isLoadingOlder: false });
      }
    },

    clearCurrentSession: () => {
      useAppshotsStore.getState().clear();
      set({
        messages: [],
        todos: [],
        streamSnapshot: null,
      });
    },

    updateSessionTitle: (sessionId: string, title: string) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? normalizeSession({ ...s, title, updatedAt: Date.now() }) : s
        ),
      }));
    },

    updateSessionEngine: async (sessionId: string, engine: Partial<AgentEngineSessionMetadata>) => {
      try {
        const payload: {
          sessionId: string;
          kind: typeof engine.kind;
          permissionProfile: typeof engine.permissionProfile;
          model?: string;
          workingDirectory?: string;
        } = {
          sessionId,
          kind: engine.kind,
          permissionProfile: engine.permissionProfile,
        };
        if (engine.model) {
          payload.model = engine.model;
        }
        if (engine.cwd) {
          payload.workingDirectory = engine.cwd;
        }
        const normalized = await invokeAgentEngine<AgentEngineSessionMetadata>('select', payload);
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === sessionId
              ? normalizeSession({
                ...s,
                engine: normalized,
                workingDirectory: engine.cwd ?? s.workingDirectory,
                updatedAt: Date.now(),
              })
              : s
          ),
        }));
      } catch (error) {
        logger.error('Failed to update session engine', error);
        await get().loadSessions();
        throw error;
      }
    },

    markSessionUnread: (sessionId: string) => {
      const { currentSessionId, unreadSessionIds } = get();
      if (currentSessionId === sessionId) return;

      const newUnreadIds = new Set(unreadSessionIds);
      newUnreadIds.add(sessionId);
      set({ unreadSessionIds: newUnreadIds });
    },

    markSessionRead: (sessionId: string) => {
      const { unreadSessionIds } = get();
      const newUnreadIds = new Set(unreadSessionIds);
      newUnreadIds.delete(sessionId);
      set({ unreadSessionIds: newUnreadIds });
    },

    isSessionUnread: (sessionId: string) => {
      return get().unreadSessionIds.has(sessionId);
    },

    updateSessionRuntime: (event: SessionStatusUpdateEvent) => {
      const { runningSessionIds, sessionRuntimes } = get();

      const newRunningIds = new Set(runningSessionIds);
      if (event.status === 'running') {
        newRunningIds.add(event.sessionId);
      } else {
        newRunningIds.delete(event.sessionId);
      }

      const newRuntimes = new Map(sessionRuntimes);
      const previousRuntime = sessionRuntimes.get(event.sessionId);
      const contextHealth = shouldReplaceContextHealth(event.contextHealth, previousRuntime?.contextHealth)
        ? event.contextHealth
        : previousRuntime?.contextHealth ?? null;
      newRuntimes.set(event.sessionId, {
        sessionId: event.sessionId,
        status: event.status,
        activeAgentCount: event.activeAgentCount,
        contextHealth,
        lastActivityAt: Date.now(),
      });

      set({
        runningSessionIds: newRunningIds,
        sessionRuntimes: newRuntimes,
      });

      if (event.sessionId === get().currentSessionId) {
        const appStore = useAppStore.getState();
        if (shouldReplaceContextHealth(contextHealth, appStore.contextHealth)) {
          appStore.setContextHealth(contextHealth ?? null);
        }
      }

      logger.debug('Session runtime updated', {
        sessionId: event.sessionId,
        status: event.status,
        activeAgentCount: event.activeAgentCount,
      });
    },

    isSessionRunning: (sessionId: string) => {
      return get().runningSessionIds.has(sessionId);
    },

    getRunningSessionCount: () => {
      return get().runningSessionIds.size;
    },

    moveToBackground: async (sessionId: string) => {
      try {
        const result = await ipcService.invoke(
          IPC_CHANNELS.BACKGROUND_MOVE_TO_BACKGROUND,
          sessionId
        );
        if (result) {
          logger.info('Session moved to background', { sessionId });
        }
        return result ?? false;
      } catch (error) {
        logger.error('Failed to move session to background', error);
        return false;
      }
    },

    moveToForeground: async (sessionId: string) => {
      try {
        const task = await ipcService.invoke(
          IPC_CHANNELS.BACKGROUND_MOVE_TO_FOREGROUND,
          sessionId
        );
        if (task) {
          await get().switchSession(sessionId);
          logger.info('Session moved to foreground', { sessionId });
        }
      } catch (error) {
        logger.error('Failed to move session to foreground', error);
      }
    },

    updateBackgroundTask: (event: BackgroundTaskUpdateEvent) => {
      const { backgroundTasks } = get();

      switch (event.type) {
        case 'added':
          set({ backgroundTasks: [...backgroundTasks, event.task] });
          break;
        case 'removed':
          set({
            backgroundTasks: backgroundTasks.filter(
              (t) => t.sessionId !== event.task.sessionId
            ),
          });
          break;
        case 'updated':
        case 'completed':
        case 'failed':
          set({
            backgroundTasks: backgroundTasks.map((t) =>
              t.sessionId === event.task.sessionId ? event.task : t
            ),
          });
          break;
      }
    },

    getBackgroundTaskCount: () => {
      return get().backgroundTasks.length;
    },

    renameSession: async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;

      get().updateSessionTitle(id, trimmed);

      try {
        await window.domainAPI!.invoke(IPC_DOMAINS.SESSION, 'update', { sessionId: id, updates: { title: trimmed } });
        logger.info('Session renamed', { sessionId: id, newTitle: trimmed });
      } catch (error) {
        logger.error('Failed to rename session', error);
      }
    },

    setSessionDesignBrief: (sessionId, brief) => {
      set((state) => {
        const next = new Map(state.sessionDesignBriefs);
        next.set(sessionId, brief);
        return { sessionDesignBriefs: next };
      });
      logger.info('Session design brief locked', { sessionId, surface: brief.surface, direction: brief.direction });
    },

    clearSessionDesignBrief: (sessionId) => {
      set((state) => {
        if (!state.sessionDesignBriefs.has(sessionId)) return state;
        const next = new Map(state.sessionDesignBriefs);
        next.delete(sessionId);
        return { sessionDesignBriefs: next };
      });
    },

    getSessionDesignBrief: (sessionId) => {
      return get().sessionDesignBriefs.get(sessionId);
    },
  }));

let _initialized = false;

export async function initializeSessionStore(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const store = useSessionStore.getState();

  await store.loadSessions();

  const { sessions, currentSessionId } = useSessionStore.getState();

  if (currentSessionId) {
    // A user action may create/select a session while the initial list request is
    // still in flight. Keep that newer session and only finish wiring listeners.
  } else if (sessions.length > 0) {
    await store.switchSession(sessions[0].id);
  } else {
    await store.createSession('新对话', { workingDirectory: null });
  }

  ipcService.on(IPC_CHANNELS.SESSION_UPDATED, (event) => {
    const { sessionId, updates } = event;
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => (
        session.id === sessionId
          ? normalizeSession({ ...session, ...updates })
          : session
      )),
    }));

    if (useSessionStore.getState().currentSessionId === sessionId && updates.workingDirectory !== undefined) {
      useAppStore.getState().setWorkingDirectory(updates.workingDirectory ?? null);
    }
  });

  ipcService.on(IPC_CHANNELS.SESSION_LIST_UPDATED, () => {
    useSessionStore.getState().loadSessions();
  });

  ipcService.on(IPC_CHANNELS.WORKSPACE_CURRENT_CHANGED, (event: { dir: string | null }) => {
    useAppStore.getState().setWorkingDirectory(event.dir ?? null);
  });

  ipcService.on(IPC_CHANNELS.SESSION_STATUS_UPDATE, (event: SessionStatusUpdateEvent) => {
    useSessionStore.getState().updateSessionRuntime(event);
  });

  ipcService.on(IPC_CHANNELS.BACKGROUND_TASK_UPDATE, (event: BackgroundTaskUpdateEvent) => {
    useSessionStore.getState().updateBackgroundTask(event);
  });

  ipcService.on(IPC_CHANNELS.STATUS_TOKEN_UPDATE, (event: { inputTokens: number; outputTokens: number }) => {
    useStatusStore.getState().updateTokens(event.inputTokens, event.outputTokens);
  });
  ipcService.on(IPC_CHANNELS.STATUS_CONTEXT_UPDATE, (event: { percent: number }) => {
    useStatusStore.getState().setContextUsage(event.percent);
  });
  ipcService.on(IPC_CHANNELS.STATUS_GIT_UPDATE, (event: { branch: string | null; changes: { staged: number; unstaged: number; untracked: number } | null }) => {
    useStatusStore.getState().setGitInfo(event.branch, useStatusStore.getState().workingDirectory);
    useStatusStore.getState().setGitChanges(event.changes);
  });

  try {
    const tasks = await ipcService.invoke(IPC_CHANNELS.BACKGROUND_GET_TASKS);
    if (tasks && tasks.length > 0) {
      useSessionStore.setState({ backgroundTasks: tasks });
    }
  } catch {
    // ignore
  }
}
