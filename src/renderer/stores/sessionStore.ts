// ============================================================================
// Session Store - 会话状态管理
// 借鉴 Zustand 最佳实践，实现会话的 CRUD 和持久化
// ============================================================================

import { create } from 'zustand';
import type { Session, Message, TodoItem } from '@shared/types';
import { IPC_CHANNELS, type SessionStatusUpdateEvent, type SessionRuntimeSummary } from '@shared/ipc';
import { createLogger } from '../utils/logger';

const logger = createLogger('SessionStore');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionWithMeta extends Session {
  messageCount: number;
}

// 会话过滤器类型
export type SessionFilter = 'active' | 'archived' | 'all';

interface SessionState {
  // 会话列表
  sessions: SessionWithMeta[];
  // 当前选中的会话 ID
  currentSessionId: string | null;
  // 当前会话的消息
  messages: Message[];
  // 当前会话的待办
  todos: TodoItem[];
  // 加载状态
  isLoading: boolean;
  // 错误信息
  error: string | null;
  // 未读会话集合（用于跨会话通知）
  unreadSessionIds: Set<string>;
  // 当前过滤器
  filter: SessionFilter;
  // 运行中的会话 ID 集合（多会话并行支持）
  runningSessionIds: Set<string>;
  // 会话运行时状态（多会话并行支持）
  sessionRuntimes: Map<string, SessionRuntimeSummary>;
}

interface SessionActions {
  // 加载会话列表
  loadSessions: () => Promise<void>;
  // 创建新会话
  createSession: (title?: string) => Promise<Session | null>;
  // 切换会话
  switchSession: (sessionId: string) => Promise<void>;
  // 删除会话
  deleteSession: (sessionId: string) => Promise<void>;
  // 归档会话
  archiveSession: (sessionId: string) => Promise<void>;
  // 取消归档
  unarchiveSession: (sessionId: string) => Promise<void>;
  // 设置过滤器
  setFilter: (filter: SessionFilter) => void;
  // 添加消息到当前会话
  addMessage: (message: Message) => void;
  // 更新消息
  updateMessage: (id: string, updates: Partial<Message>) => void;
  // 设置消息列表
  setMessages: (messages: Message[]) => void;
  // 设置待办列表
  setTodos: (todos: TodoItem[]) => void;
  // 清空当前会话
  clearCurrentSession: () => void;
  // 更新会话标题
  updateSessionTitle: (sessionId: string, title: string) => void;
  // 标记会话为未读
  markSessionUnread: (sessionId: string) => void;
  // 标记会话为已读（切换到该会话时自动调用）
  markSessionRead: (sessionId: string) => void;
  // 检查会话是否未读
  isSessionUnread: (sessionId: string) => boolean;
  // 更新会话运行状态（多会话并行支持）
  updateSessionRuntime: (event: SessionStatusUpdateEvent) => void;
  // 检查会话是否在运行
  isSessionRunning: (sessionId: string) => boolean;
  // 获取运行中的会话数量
  getRunningSessionCount: () => number;
}

type SessionStore = SessionState & SessionActions;

// ----------------------------------------------------------------------------
// Store
// ----------------------------------------------------------------------------

export const useSessionStore = create<SessionStore>()((set, get) => ({
    // 初始状态
    sessions: [],
    currentSessionId: null,
    messages: [],
    todos: [],
    isLoading: false,
    error: null,
    unreadSessionIds: new Set<string>(),
    filter: 'active' as SessionFilter,
    runningSessionIds: new Set<string>(),
    sessionRuntimes: new Map<string, SessionRuntimeSummary>(),

    // 加载会话列表
    loadSessions: async () => {
      const { filter } = get();
      set({ isLoading: true, error: null });
      try {
        // 根据过滤器决定是否包含归档会话
        const includeArchived = filter === 'archived' || filter === 'all';
        const sessions = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_LIST, { includeArchived });

        // 转换为 SessionWithMeta 格式并根据过滤器筛选
        let sessionsWithMeta: SessionWithMeta[] = (sessions || []).map((s: Session & { messageCount?: number }) => ({
          ...s,
          messageCount: s.messageCount || 0,
        }));

        // 客户端过滤：active 只显示未归档，archived 只显示已归档，all 显示全部
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

    // 创建新会话
    createSession: async (title?: string) => {
      set({ isLoading: true, error: null });
      try {
        const session = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_CREATE, title);
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

    // 切换会话
    switchSession: async (sessionId: string) => {
      const { currentSessionId, unreadSessionIds } = get();
      if (currentSessionId === sessionId) return;

      set({ isLoading: true, error: null });
      try {
        const session = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_LOAD, sessionId) as Session & { messages?: Message[]; todos?: TodoItem[] };
        if (session) {
          // 切换时自动标记为已读
          const newUnreadIds = new Set(unreadSessionIds);
          newUnreadIds.delete(sessionId);

          set({
            currentSessionId: sessionId,
            messages: session.messages || [],
            todos: session.todos || [],
            isLoading: false,
            unreadSessionIds: newUnreadIds,
          });
        }
      } catch (error) {
        logger.error('Failed to switch session', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to switch session',
          isLoading: false
        });
      }
    },

    // 删除会话
    deleteSession: async (sessionId: string) => {
      try {
        await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId);

        const { currentSessionId, sessions } = get();
        const newSessions = sessions.filter((s) => s.id !== sessionId);

        // 如果删除的是当前会话，切换到第一个会话或清空
        if (currentSessionId === sessionId) {
          if (newSessions.length > 0) {
            // 切换到第一个会话
            set({ sessions: newSessions });
            await get().switchSession(newSessions[0].id);
          } else {
            // 没有会话了，创建新的
            set({ sessions: newSessions });
            await get().createSession();
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

    // 归档会话
    archiveSession: async (sessionId: string) => {
      try {
        await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_ARCHIVE, sessionId);

        const { currentSessionId, sessions, filter } = get();

        // 如果当前过滤器是 active，从列表中移除
        if (filter === 'active') {
          const newSessions = sessions.filter((s) => s.id !== sessionId);

          // 如果归档的是当前会话，切换到第一个
          if (currentSessionId === sessionId) {
            if (newSessions.length > 0) {
              set({ sessions: newSessions });
              await get().switchSession(newSessions[0].id);
            } else {
              set({ sessions: newSessions });
              await get().createSession();
            }
          } else {
            set({ sessions: newSessions });
          }
        } else {
          // 如果是 all 过滤器，更新会话状态
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

    // 取消归档
    unarchiveSession: async (sessionId: string) => {
      try {
        await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_UNARCHIVE, sessionId);

        const { sessions, filter } = get();

        // 如果当前过滤器是 archived，从列表中移除
        if (filter === 'archived') {
          set({
            sessions: sessions.filter((s) => s.id !== sessionId),
          });
        } else {
          // 如果是 all 或 active 过滤器，更新会话状态
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

    // 设置过滤器
    setFilter: (filter: SessionFilter) => {
      set({ filter });
      // 切换过滤器后重新加载会话列表
      get().loadSessions();
    },

    // 添加消息
    addMessage: (message: Message) => {
      set((state) => ({
        messages: [...state.messages, message],
      }));

      // 更新会话的消息计数
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

    // 更新消息
    updateMessage: (id: string, updates: Partial<Message>) => {
      set((state) => ({
        messages: state.messages.map((msg) =>
          msg.id === id ? { ...msg, ...updates } : msg
        ),
      }));
    },

    // 设置消息列表
    setMessages: (messages: Message[]) => {
      set({ messages });
    },

    // 设置待办列表
    setTodos: (todos: TodoItem[]) => {
      set({ todos });
    },

    // 清空当前会话
    clearCurrentSession: () => {
      set({
        messages: [],
        todos: [],
      });
    },

    // 更新会话标题
    updateSessionTitle: (sessionId: string, title: string) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, title, updatedAt: Date.now() } : s
        ),
      }));
    },

    // 标记会话为未读
    markSessionUnread: (sessionId: string) => {
      const { currentSessionId, unreadSessionIds } = get();
      // 不标记当前会话为未读
      if (currentSessionId === sessionId) return;

      const newUnreadIds = new Set(unreadSessionIds);
      newUnreadIds.add(sessionId);
      set({ unreadSessionIds: newUnreadIds });
    },

    // 标记会话为已读
    markSessionRead: (sessionId: string) => {
      const { unreadSessionIds } = get();
      const newUnreadIds = new Set(unreadSessionIds);
      newUnreadIds.delete(sessionId);
      set({ unreadSessionIds: newUnreadIds });
    },

    // 检查会话是否未读
    isSessionUnread: (sessionId: string) => {
      return get().unreadSessionIds.has(sessionId);
    },

    // 更新会话运行状态（多会话并行支持）
    updateSessionRuntime: (event: SessionStatusUpdateEvent) => {
      const { runningSessionIds, sessionRuntimes } = get();

      // 更新运行状态
      const newRunningIds = new Set(runningSessionIds);
      if (event.status === 'running') {
        newRunningIds.add(event.sessionId);
      } else {
        newRunningIds.delete(event.sessionId);
      }

      // 更新运行时摘要
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

    // 检查会话是否在运行
    isSessionRunning: (sessionId: string) => {
      return get().runningSessionIds.has(sessionId);
    },

    // 获取运行中的会话数量
    getRunningSessionCount: () => {
      return get().runningSessionIds.size;
    },
  }));

// ----------------------------------------------------------------------------
// 初始化 Hook - 在应用启动时调用
// ----------------------------------------------------------------------------

export async function initializeSessionStore(): Promise<void> {
  const store = useSessionStore.getState();

  // 加载会话列表
  await store.loadSessions();

  const { sessions } = useSessionStore.getState();

  // 如果有会话，加载最近的一个
  if (sessions.length > 0) {
    await store.switchSession(sessions[0].id);
  } else {
    // 没有会话，创建一个新的
    await store.createSession('新对话');
  }

  // 监听会话更新事件（如标题更新）
  window.electronAPI?.on(IPC_CHANNELS.SESSION_UPDATED, (event) => {
    const { sessionId, updates } = event;
    useSessionStore.getState().updateSessionTitle(sessionId, updates.title || '');
  });

  // 监听会话状态更新事件（多会话并行支持）
  window.electronAPI?.on(IPC_CHANNELS.SESSION_STATUS_UPDATE, (event: SessionStatusUpdateEvent) => {
    useSessionStore.getState().updateSessionRuntime(event);
  });
}
