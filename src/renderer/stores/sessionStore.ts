// ============================================================================
// Session Store - 会话状态管理
// 借鉴 Zustand 最佳实践，实现会话的 CRUD 和持久化
// ============================================================================

import { create } from 'zustand';
import type { Session, Message, TodoItem } from '@shared/types';
import { IPC_CHANNELS } from '@shared/ipc';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SessionWithMeta extends Session {
  messageCount: number;
}

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

    // 加载会话列表
    loadSessions: async () => {
      set({ isLoading: true, error: null });
      try {
        const sessions = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_LIST);
        // 转换为 SessionWithMeta 格式
        const sessionsWithMeta: SessionWithMeta[] = (sessions || []).map((s: any) => ({
          ...s,
          messageCount: s.messageCount || 0,
        }));
        set({ sessions: sessionsWithMeta, isLoading: false });
      } catch (error) {
        console.error('Failed to load sessions:', error);
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
        console.error('Failed to create session:', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to create session',
          isLoading: false
        });
        return null;
      }
    },

    // 切换会话
    switchSession: async (sessionId: string) => {
      const { currentSessionId } = get();
      if (currentSessionId === sessionId) return;

      set({ isLoading: true, error: null });
      try {
        const session = await window.electronAPI?.invoke(IPC_CHANNELS.SESSION_LOAD, sessionId) as any;
        if (session) {
          set({
            currentSessionId: sessionId,
            messages: session.messages || [],
            todos: session.todos || [],
            isLoading: false,
          });
        }
      } catch (error) {
        console.error('Failed to switch session:', error);
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
        console.error('Failed to delete session:', error);
        set({
          error: error instanceof Error ? error.message : 'Failed to delete session',
        });
      }
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
}
