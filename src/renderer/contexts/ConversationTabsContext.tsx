// ============================================================================
// ConversationTabsContext - Tab 状态管理和持久化
// ============================================================================

import React, { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useSessionStore, type SessionWithMeta } from '../stores/sessionStore';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ConversationTab {
  id: string;           // 对应 Session ID
  title: string;        // Tab 标题
  isPinned: boolean;    // 是否固定
}

interface TabsState {
  tabs: ConversationTab[];
  activeTabId: string | null;
}

interface TabsActions {
  // 添加 Tab
  addTab: (sessionId: string, title: string) => void;
  // 关闭 Tab
  closeTab: (tabId: string) => void;
  // 切换 Tab
  setActiveTab: (tabId: string) => void;
  // 更新 Tab 标题
  updateTabTitle: (tabId: string, title: string) => void;
  // 移动 Tab（拖拽排序）
  moveTab: (fromIndex: number, toIndex: number) => void;
  // 固定/取消固定 Tab
  togglePinTab: (tabId: string) => void;
  // 关闭其他 Tab
  closeOtherTabs: (keepTabId: string) => void;
  // 关闭左侧 Tab
  closeTabsToLeft: (tabId: string) => void;
  // 关闭右侧 Tab
  closeTabsToRight: (tabId: string) => void;
  // 关闭所有 Tab
  closeAllTabs: () => void;
  // 从 sessions 同步 tabs
  syncFromSessions: (sessions: SessionWithMeta[]) => void;
  // 加载持久化数据
  loadFromStorage: () => void;
}

type TabsStore = TabsState & TabsActions;

// ----------------------------------------------------------------------------
// localStorage 持久化
// ----------------------------------------------------------------------------

const STORAGE_KEY = 'code-agent-conversation-tabs';
const STORAGE_VERSION = 1;

interface StoredTabsData {
  version: number;
  tabs: ConversationTab[];
  activeTabId: string | null;
}

function saveToStorage(state: TabsState): void {
  try {
    const data: StoredTabsData = {
      version: STORAGE_VERSION,
      tabs: state.tabs,
      activeTabId: state.activeTabId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn('Failed to save tabs to localStorage:', error);
  }
}

function loadFromStorage(): TabsState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const data = JSON.parse(raw) as StoredTabsData;

    // 版本兼容检查
    if (data.version !== STORAGE_VERSION) {
      console.warn('Tabs storage version mismatch, clearing');
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return {
      tabs: data.tabs || [],
      activeTabId: data.activeTabId,
    };
  } catch (error) {
    console.warn('Failed to load tabs from localStorage:', error);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Zustand Store
// ----------------------------------------------------------------------------

export const useTabsStore = create<TabsStore>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  addTab: (sessionId: string, title: string) => {
    const { tabs } = get();
    // 检查是否已存在
    if (tabs.some(t => t.id === sessionId)) {
      set({ activeTabId: sessionId });
      return;
    }

    const newTab: ConversationTab = {
      id: sessionId,
      title,
      isPinned: false,
    };

    set(state => {
      const newState = {
        tabs: [...state.tabs, newTab],
        activeTabId: sessionId,
      };
      saveToStorage(newState);
      return newState;
    });
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = tabs.filter(t => t.id !== tabId);
    let newActiveId = activeTabId;

    // 如果关闭的是当前 Tab，切换到相邻 Tab
    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        // 优先切换到右侧，否则左侧
        const newIndex = Math.min(tabIndex, newTabs.length - 1);
        newActiveId = newTabs[newIndex].id;
      } else {
        newActiveId = null;
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId });
    saveToStorage({ tabs: newTabs, activeTabId: newActiveId });
  },

  setActiveTab: (tabId: string) => {
    set(state => {
      const newState = { ...state, activeTabId: tabId };
      saveToStorage(newState);
      return newState;
    });
  },

  updateTabTitle: (tabId: string, title: string) => {
    set(state => {
      const newTabs = state.tabs.map(t =>
        t.id === tabId ? { ...t, title } : t
      );
      const newState = { ...state, tabs: newTabs };
      saveToStorage(newState);
      return newState;
    });
  },

  moveTab: (fromIndex: number, toIndex: number) => {
    const { tabs } = get();
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= tabs.length) return;
    if (toIndex < 0 || toIndex >= tabs.length) return;

    const newTabs = [...tabs];
    const [movedTab] = newTabs.splice(fromIndex, 1);
    newTabs.splice(toIndex, 0, movedTab);

    set(state => {
      const newState = { ...state, tabs: newTabs };
      saveToStorage(newState);
      return newState;
    });
  },

  togglePinTab: (tabId: string) => {
    set(state => {
      const newTabs = state.tabs.map(t =>
        t.id === tabId ? { ...t, isPinned: !t.isPinned } : t
      );
      // 重排序：固定的 Tab 在前
      newTabs.sort((a, b) => {
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        return 0;
      });
      const newState = { ...state, tabs: newTabs };
      saveToStorage(newState);
      return newState;
    });
  },

  closeOtherTabs: (keepTabId: string) => {
    set(state => {
      // 保留固定的和指定的 Tab
      const newTabs = state.tabs.filter(t => t.id === keepTabId || t.isPinned);
      const newState = { tabs: newTabs, activeTabId: keepTabId };
      saveToStorage(newState);
      return newState;
    });
  },

  closeTabsToLeft: (tabId: string) => {
    const { tabs } = get();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex <= 0) return;

    set(state => {
      const newTabs = state.tabs.filter((t, i) => i >= tabIndex || t.isPinned);
      const newState = { ...state, tabs: newTabs };
      saveToStorage(newState);
      return newState;
    });
  },

  closeTabsToRight: (tabId: string) => {
    const { tabs } = get();
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1 || tabIndex === tabs.length - 1) return;

    set(state => {
      const newTabs = state.tabs.filter((t, i) => i <= tabIndex || t.isPinned);
      const newState = { ...state, tabs: newTabs };
      saveToStorage(newState);
      return newState;
    });
  },

  closeAllTabs: () => {
    set(state => {
      // 只保留固定的 Tab
      const pinnedTabs = state.tabs.filter(t => t.isPinned);
      const newActiveId = pinnedTabs.length > 0 ? pinnedTabs[0].id : null;
      const newState = { tabs: pinnedTabs, activeTabId: newActiveId };
      saveToStorage(newState);
      return newState;
    });
  },

  syncFromSessions: (sessions: SessionWithMeta[]) => {
    const { tabs } = get();

    // 移除不存在的 session 对应的 tab
    const sessionIds = new Set(sessions.map(s => s.id));
    const validTabs = tabs.filter(t => sessionIds.has(t.id));

    // 更新 tab 标题
    const updatedTabs = validTabs.map(t => {
      const session = sessions.find(s => s.id === t.id);
      if (session && session.title !== t.title) {
        return { ...t, title: session.title };
      }
      return t;
    });

    // 检查是否有变化
    if (JSON.stringify(updatedTabs) !== JSON.stringify(tabs)) {
      set(state => {
        // 如果当前 activeTabId 不在有效 tabs 中，重置
        const newActiveId = updatedTabs.some(t => t.id === state.activeTabId)
          ? state.activeTabId
          : (updatedTabs.length > 0 ? updatedTabs[0].id : null);

        const newState = { tabs: updatedTabs, activeTabId: newActiveId };
        saveToStorage(newState);
        return newState;
      });
    }
  },

  loadFromStorage: () => {
    const stored = loadFromStorage();
    if (stored) {
      set(stored);
    }
  },
}));

// ----------------------------------------------------------------------------
// Context for React integration
// ----------------------------------------------------------------------------

interface ConversationTabsContextValue {
  tabs: ConversationTab[];
  activeTabId: string | null;
  addTab: (sessionId: string, title: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  togglePinTab: (tabId: string) => void;
  closeOtherTabs: (keepTabId: string) => void;
  closeTabsToLeft: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  closeAllTabs: () => void;
}

const ConversationTabsContext = createContext<ConversationTabsContextValue | null>(null);

// ----------------------------------------------------------------------------
// Provider Component
// ----------------------------------------------------------------------------

export const ConversationTabsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initialized = useRef(false);

  const tabs = useTabsStore(state => state.tabs);
  const activeTabId = useTabsStore(state => state.activeTabId);
  const addTab = useTabsStore(state => state.addTab);
  const closeTab = useTabsStore(state => state.closeTab);
  const setActiveTab = useTabsStore(state => state.setActiveTab);
  const moveTab = useTabsStore(state => state.moveTab);
  const togglePinTab = useTabsStore(state => state.togglePinTab);
  const closeOtherTabs = useTabsStore(state => state.closeOtherTabs);
  const closeTabsToLeft = useTabsStore(state => state.closeTabsToLeft);
  const closeTabsToRight = useTabsStore(state => state.closeTabsToRight);
  const closeAllTabs = useTabsStore(state => state.closeAllTabs);
  const syncFromSessions = useTabsStore(state => state.syncFromSessions);
  const loadFromStorageAction = useTabsStore(state => state.loadFromStorage);

  const sessions = useSessionStore(state => state.sessions);
  const currentSessionId = useSessionStore(state => state.currentSessionId);
  const switchSession = useSessionStore(state => state.switchSession);

  // 初始化：加载持久化数据
  useEffect(() => {
    if (!initialized.current) {
      loadFromStorageAction();
      initialized.current = true;
    }
  }, [loadFromStorageAction]);

  // 同步 sessions 变化
  useEffect(() => {
    if (sessions.length > 0) {
      syncFromSessions(sessions);
    }
  }, [sessions, syncFromSessions]);

  // 当 sessionStore 切换会话时，同步到 tabs
  useEffect(() => {
    if (currentSessionId && currentSessionId !== activeTabId) {
      const session = sessions.find(s => s.id === currentSessionId);
      if (session) {
        // 检查是否已有此 tab
        const existingTab = tabs.find(t => t.id === currentSessionId);
        if (existingTab) {
          setActiveTab(currentSessionId);
        } else {
          addTab(currentSessionId, session.title);
        }
      }
    }
  }, [currentSessionId, activeTabId, sessions, tabs, setActiveTab, addTab]);

  // 当 tabs activeTabId 变化时，同步到 sessionStore
  const handleSetActiveTab = useCallback((tabId: string) => {
    setActiveTab(tabId);
    if (tabId !== currentSessionId) {
      switchSession(tabId);
    }
  }, [setActiveTab, currentSessionId, switchSession]);

  // 关闭 tab 时，如果是当前 tab，需要切换会话
  const handleCloseTab = useCallback((tabId: string) => {
    closeTab(tabId);
    // closeTab 内部会更新 activeTabId，需要同步到 sessionStore
    const newActiveId = useTabsStore.getState().activeTabId;
    if (newActiveId && newActiveId !== currentSessionId) {
      switchSession(newActiveId);
    }
  }, [closeTab, currentSessionId, switchSession]);

  const value: ConversationTabsContextValue = {
    tabs,
    activeTabId,
    addTab,
    closeTab: handleCloseTab,
    setActiveTab: handleSetActiveTab,
    moveTab,
    togglePinTab,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    closeAllTabs,
  };

  return (
    <ConversationTabsContext.Provider value={value}>
      {children}
    </ConversationTabsContext.Provider>
  );
};

// ----------------------------------------------------------------------------
// Hook
// ----------------------------------------------------------------------------

export function useConversationTabs(): ConversationTabsContextValue {
  const context = useContext(ConversationTabsContext);
  if (!context) {
    throw new Error('useConversationTabs must be used within ConversationTabsProvider');
  }
  return context;
}
