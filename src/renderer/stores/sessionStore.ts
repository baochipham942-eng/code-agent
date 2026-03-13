import { create } from 'zustand';
import type { Session, Message, TodoItem } from '@shared/types';
import { IPC_CHANNELS, IPC_DOMAINS, type SessionStatusUpdateEvent, type SessionRuntimeSummary } from '@shared/ipc';
import { useStatusStore } from './statusStore';
import type { BackgroundTaskInfo, BackgroundTaskUpdateEvent } from '@shared/types/sessionState';
import { createLogger } from '../utils/logger';
import ipcService from '../services/ipcService';

const logger = createLogger('SessionStore');

async function invokeSession<T>(action: string, payload?: unknown): Promise<T> {
  const response = await window.domainAPI?.invoke<T>(IPC_DOMAINS.SESSION, action, payload);
  if (!response?.success) {
    throw new Error(response?.error?.message || `Session action failed: ${action}`);
  }
  return response.data as T;
}

// switchSession 竞态保护计数器
let _switchCounter = 0;

export interface SessionWithMeta extends Session {
  messageCount: number;
}

export type SessionFilter = 'active' | 'archived' | 'all';

interface SessionState {
  sessions: SessionWithMeta[];
  currentSessionId: string | null;
  messages: Message[];
  todos: TodoItem[];
  isLoading: boolean;
  error: string | null;
  unreadSessionIds: Set<string>;
  runningSessionIds: Set<string>;
  sessionRuntimes: Map<string, SessionRuntimeSummary>;
  backgroundTasks: BackgroundTaskInfo[];
  hasOlderMessages: boolean;
  isLoadingOlder: boolean;
}

interface SessionActions {
  loadSessions: () => Promise<void>;
  createSession: (title?: string) => Promise<Session | null>;
  switchSession: (sessionId: string) => Promise<void>;
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
}

type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()((set, get) => ({
    sessions: [],
    currentSessionId: null,
    messages: [],
    todos: [],
    isLoading: false,
    error: null,
    unreadSessionIds: new Set<string>(),
    runningSessionIds: new Set<string>(),
    sessionRuntimes: new Map<string, SessionRuntimeSummary>(),
    backgroundTasks: [],
    hasOlderMessages: false,
    isLoadingOlder: false,

    loadSessions: async () => {
      const { useSessionUIStore } = await import('./sessionUIStore');
      const { filter } = useSessionUIStore.getState();
      set({ isLoading: true, error: null });
      try {
        const includeArchived = filter === 'archived' || filter === 'all';
        const sessions = await invokeSession<Session[]>('list', { includeArchived });

        let sessionsWithMeta: SessionWithMeta[] = (sessions || []).map((s: Session & { messageCount?: number }) => ({
          ...s,
          title: s.title || '未命名会话',
          updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : (Number.isFinite(s.createdAt) ? s.createdAt : Date.now()),
          createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
          messageCount: s.messageCount || 0,
        }));

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

    createSession: async (title?: string) => {
      set({ isLoading: true, error: null });
      try {
        const session = await invokeSession<Session | null>('create', { title });
        if (session) {
          const newSessionWithMeta: SessionWithMeta = {
            ...session,
            messageCount: 0,
          };
          set((state) => ({
            sessions: [newSessionWithMeta, ...state.sessions],
            currentSessionId: session.id,
            messages: [],
            todos: [],
            isLoading: false,
          }));
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

      set({ isLoading: true, error: null });
      try {
        const session = await invokeSession<Session & { messages?: Message[]; todos?: TodoItem[] } | null>('load', { sessionId });

        // 竞态检查：如果在等待期间又发起了新的切换，丢弃本次结果
        if (switchVersion !== _switchCounter) {
          logger.debug('switchSession stale response discarded', { sessionId, switchVersion, current: _switchCounter });
          return;
        }

        if (session) {
          const newUnreadIds = new Set(unreadSessionIds);
          newUnreadIds.delete(sessionId);

          const loadedMessages = session.messages || [];
          const totalCount = (session as any).messageCount ?? loadedMessages.length;
          set({
            currentSessionId: sessionId,
            messages: loadedMessages,
            todos: session.todos || [],
            isLoading: false,
            unreadSessionIds: newUnreadIds,
            hasOlderMessages: totalCount > loadedMessages.length,
            isLoadingOlder: false,
          });
        } else {
          // 后端返回 null/undefined — 仍然切换到该会话（显示空状态）
          logger.warn('switchSession: backend returned null session', { sessionId });
          set({
            currentSessionId: sessionId,
            messages: [],
            todos: [],
            isLoading: false,
          });
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
            set({ sessions: newSessions, currentSessionId: null, messages: [] });
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

        const { useSessionUIStore } = await import('./sessionUIStore');
        const { filter } = useSessionUIStore.getState();
        const { currentSessionId, sessions } = get();

        if (filter === 'active') {
          const newSessions = sessions.filter((s) => s.id !== sessionId);

          if (currentSessionId === sessionId) {
            if (newSessions.length > 0) {
              set({ sessions: newSessions });
              await get().switchSession(newSessions[0].id);
            } else {
              set({ sessions: newSessions, currentSessionId: null, messages: [] });
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

        const { useSessionUIStore } = await import('./sessionUIStore');
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
        messages: [...state.messages, message],
      }));

      const { currentSessionId, sessions } = get();
      if (currentSessionId) {
        set({
          sessions: sessions.map((s) =>
            s.id === currentSessionId
              ? { ...s, messageCount: s.messageCount + 1, updatedAt: Date.now() }
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
    },

    setMessages: (messages: Message[]) => {
      set({ messages });
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
          const olderMessages = result.messages;
          const hasMore = result.hasMore;
          set(state => ({
            messages: [...olderMessages, ...state.messages],
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
      set({
        messages: [],
        todos: [],
      });
    },

    updateSessionTitle: (sessionId: string, title: string) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s
        ),
      }));
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
      newRuntimes.set(event.sessionId, {
        sessionId: event.sessionId,
        status: event.status,
        activeAgentCount: event.activeAgentCount,
        contextHealth: event.contextHealth,
        lastActivityAt: Date.now(),
      });

      set({
        runningSessionIds: newRunningIds,
        sessionRuntimes: newRuntimes,
      });

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
  }));

let _initialized = false;

export async function initializeSessionStore(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const store = useSessionStore.getState();

  await store.loadSessions();

  const { sessions } = useSessionStore.getState();

  if (sessions.length > 0) {
    await store.switchSession(sessions[0].id);
  } else {
    await store.createSession('新对话');
  }

  ipcService.on(IPC_CHANNELS.SESSION_UPDATED, (event) => {
    const { sessionId, updates } = event;
    if (updates.title) {
      useSessionStore.getState().updateSessionTitle(sessionId, updates.title);
    }
  });

  ipcService.on(IPC_CHANNELS.SESSION_LIST_UPDATED, () => {
    useSessionStore.getState().loadSessions();
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
