// ============================================================================
// Keyboard Shortcuts Hook - 全局快捷键
// 支持 10+ 常用操作
// ============================================================================

import { useEffect, useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('KeyboardShortcuts');

// ============================================================================
// Types
// ============================================================================

export interface KeyboardShortcut {
  /** 快捷键 ID */
  id: string;
  /** 显示名称 */
  label: string;
  /** 按键组合（Mac） */
  keyMac: string;
  /** 按键组合（Windows/Linux） */
  keyWin: string;
  /** 描述 */
  description: string;
  /** 分类 */
  category: 'session' | 'navigation' | 'editing' | 'view';
  /** 是否启用 */
  enabled: boolean;
}

export interface KeyboardShortcutsConfig {
  /** 是否启用后台任务快捷键 (Ctrl/Cmd+B) */
  enableBackground?: boolean;
  /** 是否启用新会话快捷键 (Ctrl/Cmd+N) */
  enableNewSession?: boolean;
  /** 是否启用设置快捷键 (Ctrl/Cmd+,) */
  enableSettings?: boolean;
  /** 是否启用清空对话快捷键 (Ctrl/Cmd+K) */
  enableClearChat?: boolean;
  /** 是否启用聚焦输入快捷键 (Ctrl/Cmd+L) */
  enableFocusInput?: boolean;
  /** 是否启用侧边栏切换快捷键 (Ctrl/Cmd+/) */
  enableToggleSidebar?: boolean;
  /** 是否启用 DAG 面板快捷键 (Ctrl/Cmd+D) */
  enableToggleDAG?: boolean;
  /** 是否启用工作区快捷键 (Ctrl/Cmd+E) */
  enableToggleWorkspace?: boolean;
  /** 是否启用会话切换快捷键 (Ctrl/Cmd+[ 和 Ctrl/Cmd+]) */
  enableSwitchSession?: boolean;
  /** 是否启用取消快捷键 (Escape) */
  enableCancel?: boolean;
  /** 自定义快捷键处理 */
  customHandlers?: Record<string, () => void | Promise<void>>;
}

// ============================================================================
// Default Shortcuts
// ============================================================================

export const DEFAULT_SHORTCUTS: KeyboardShortcut[] = [
  // Session
  {
    id: 'newSession',
    label: '新建会话',
    keyMac: '⌘N',
    keyWin: 'Ctrl+N',
    description: '创建一个新的对话会话',
    category: 'session',
    enabled: true,
  },
  {
    id: 'moveToBackground',
    label: '移至后台',
    keyMac: '⌘B',
    keyWin: 'Ctrl+B',
    description: '将当前运行中的会话移至后台',
    category: 'session',
    enabled: true,
  },
  {
    id: 'clearChat',
    label: '清空对话',
    keyMac: '⌘K',
    keyWin: 'Ctrl+K',
    description: '清空当前会话的消息历史',
    category: 'session',
    enabled: true,
  },
  {
    id: 'prevSession',
    label: '上一个会话',
    keyMac: '⌘[',
    keyWin: 'Ctrl+[',
    description: '切换到上一个会话',
    category: 'session',
    enabled: true,
  },
  {
    id: 'nextSession',
    label: '下一个会话',
    keyMac: '⌘]',
    keyWin: 'Ctrl+]',
    description: '切换到下一个会话',
    category: 'session',
    enabled: true,
  },

  // Navigation
  {
    id: 'focusInput',
    label: '聚焦输入框',
    keyMac: '⌘L',
    keyWin: 'Ctrl+L',
    description: '将焦点移至消息输入框',
    category: 'navigation',
    enabled: true,
  },
  {
    id: 'openSettings',
    label: '打开设置',
    keyMac: '⌘,',
    keyWin: 'Ctrl+,',
    description: '打开应用设置',
    category: 'navigation',
    enabled: true,
  },
  {
    id: 'commandPalette',
    label: '命令面板',
    keyMac: '⌘⇧P',
    keyWin: 'Ctrl+Shift+P',
    description: '打开命令面板',
    category: 'navigation',
    enabled: true,
  },

  // View
  {
    id: 'toggleSidebar',
    label: '切换侧边栏',
    keyMac: '⌘/',
    keyWin: 'Ctrl+/',
    description: '显示或隐藏侧边栏',
    category: 'view',
    enabled: true,
  },
  {
    id: 'toggleDAG',
    label: '切换 DAG 面板',
    keyMac: '⌘D',
    keyWin: 'Ctrl+D',
    description: '显示或隐藏任务 DAG 可视化面板',
    category: 'view',
    enabled: true,
  },
  {
    id: 'toggleWorkspace',
    label: '切换工作区',
    keyMac: '⌘E',
    keyWin: 'Ctrl+E',
    description: '显示或隐藏工作区面板',
    category: 'view',
    enabled: true,
  },

  // Editing
  {
    id: 'cancel',
    label: '取消',
    keyMac: 'Esc',
    keyWin: 'Esc',
    description: '取消当前操作或关闭对话框',
    category: 'editing',
    enabled: true,
  },
];

// ============================================================================
// Hook
// ============================================================================

/**
 * 全局快捷键 Hook
 *
 * 支持以下快捷键：
 * - Cmd/Ctrl+N: 新建会话
 * - Cmd/Ctrl+B: 移至后台
 * - Cmd/Ctrl+K: 清空对话
 * - Cmd/Ctrl+L: 聚焦输入框
 * - Cmd/Ctrl+,: 打开设置
 * - Cmd/Ctrl+/: 切换侧边栏
 * - Cmd/Ctrl+D: 切换 DAG 面板
 * - Cmd/Ctrl+E: 切换工作区
 * - Cmd/Ctrl+[: 上一个会话
 * - Cmd/Ctrl+]: 下一个会话
 * - Cmd/Ctrl+Shift+P: 命令面板
 * - Escape: 取消操作
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig = {}): void {
  const {
    enableBackground = true,
    enableNewSession = true,
    enableSettings = true,
    enableClearChat = true,
    enableFocusInput = true,
    enableToggleSidebar = true,
    enableToggleDAG = true,
    enableToggleWorkspace = true,
    enableSwitchSession = true,
    enableCancel = true,
    customHandlers = {},
  } = config;

  const {
    currentSessionId,
    sessions,
    isSessionRunning,
    moveToBackground,
    createSession,
    switchSession,
    clearCurrentSession,
  } = useSessionStore();

  const {
    setShowSettings,
    setSidebarCollapsed,
    sidebarCollapsed,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    pendingPermissionRequest,
    setPendingPermissionRequest,
    isProcessing,
  } = useAppStore();

  // 获取当前会话在列表中的索引
  const currentSessionIndex = useMemo(() => {
    if (!currentSessionId) return -1;
    return sessions.findIndex(s => s.id === currentSessionId);
  }, [currentSessionId, sessions]);

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;

      // 检查是否在输入框中
      const target = event.target as HTMLElement;
      const isInputField = target.tagName === 'INPUT' ||
                          target.tagName === 'TEXTAREA' ||
                          target.isContentEditable;

      // Escape 总是生效（关闭对话框、取消操作）
      if (event.key === 'Escape' && enableCancel) {
        // 如果有权限请求，关闭它
        if (pendingPermissionRequest) {
          event.preventDefault();
          setPendingPermissionRequest(null);
          return;
        }

        // 如果设置打开，关闭它
        if (useAppStore.getState().showSettings) {
          event.preventDefault();
          setShowSettings(false);
          return;
        }

        // 触发自定义取消处理
        if (customHandlers.cancel) {
          event.preventDefault();
          customHandlers.cancel();
          return;
        }
      }

      // 其他快捷键需要 modifier
      if (!modifier) return;

      // Shift 组合键
      if (event.shiftKey) {
        switch (event.key.toLowerCase()) {
          case 'p':
            // Cmd/Ctrl+Shift+P: 命令面板
            event.preventDefault();
            logger.info('Shortcut: Command palette');
            if (customHandlers.commandPalette) {
              customHandlers.commandPalette();
            }
            return;
        }
        return;
      }

      switch (event.key.toLowerCase()) {
        case 'b':
          // Cmd/Ctrl+B: 移至后台
          if (enableBackground && currentSessionId && isSessionRunning(currentSessionId)) {
            event.preventDefault();
            logger.info('Shortcut: Move to background', { sessionId: currentSessionId });
            const success = await moveToBackground(currentSessionId);
            if (success) {
              await createSession();
            }
          }
          break;

        case 'n':
          // Cmd/Ctrl+N: 新会话
          if (enableNewSession) {
            event.preventDefault();
            logger.info('Shortcut: New session');
            await createSession();
          }
          break;

        case ',':
          // Cmd/Ctrl+,: 设置
          if (enableSettings) {
            event.preventDefault();
            logger.info('Shortcut: Open settings');
            setShowSettings(true);
          }
          break;

        case 'k':
          // Cmd/Ctrl+K: 清空对话（不在输入框中时）
          if (enableClearChat && !isInputField && !isProcessing) {
            event.preventDefault();
            logger.info('Shortcut: Clear chat');
            clearCurrentSession();
          }
          break;

        case 'l':
          // Cmd/Ctrl+L: 聚焦输入框
          if (enableFocusInput) {
            event.preventDefault();
            logger.info('Shortcut: Focus input');
            const inputEl = document.querySelector('[data-chat-input]') as HTMLTextAreaElement;
            inputEl?.focus();
          }
          break;

        case '/':
          // Cmd/Ctrl+/: 切换侧边栏
          if (enableToggleSidebar) {
            event.preventDefault();
            logger.info('Shortcut: Toggle sidebar');
            setSidebarCollapsed(!sidebarCollapsed);
          }
          break;

        case 'd':
          // Cmd/Ctrl+D: 切换 DAG 面板（不在输入框中时，避免与书签冲突）
          if (enableToggleDAG && !isInputField) {
            event.preventDefault();
            logger.info('Shortcut: Toggle DAG panel');
            setShowDAGPanel(!showDAGPanel);
          }
          break;

        case 'e':
          // Cmd/Ctrl+E: 切换工作区（不在输入框中时）
          if (enableToggleWorkspace && !isInputField) {
            event.preventDefault();
            logger.info('Shortcut: Toggle workspace');
            setShowWorkspace(!showWorkspace);
          }
          break;

        case '[':
          // Cmd/Ctrl+[: 上一个会话
          if (enableSwitchSession && sessions.length > 1) {
            event.preventDefault();
            const prevIndex = currentSessionIndex > 0 ? currentSessionIndex - 1 : sessions.length - 1;
            logger.info('Shortcut: Previous session', { index: prevIndex });
            await switchSession(sessions[prevIndex].id);
          }
          break;

        case ']':
          // Cmd/Ctrl+]: 下一个会话
          if (enableSwitchSession && sessions.length > 1) {
            event.preventDefault();
            const nextIndex = currentSessionIndex < sessions.length - 1 ? currentSessionIndex + 1 : 0;
            logger.info('Shortcut: Next session', { index: nextIndex });
            await switchSession(sessions[nextIndex].id);
          }
          break;
      }
    },
    [
      enableBackground,
      enableNewSession,
      enableSettings,
      enableClearChat,
      enableFocusInput,
      enableToggleSidebar,
      enableToggleDAG,
      enableToggleWorkspace,
      enableSwitchSession,
      enableCancel,
      customHandlers,
      currentSessionId,
      currentSessionIndex,
      sessions,
      isSessionRunning,
      moveToBackground,
      createSession,
      switchSession,
      clearCurrentSession,
      setShowSettings,
      setSidebarCollapsed,
      sidebarCollapsed,
      setShowDAGPanel,
      showDAGPanel,
      setShowWorkspace,
      showWorkspace,
      pendingPermissionRequest,
      setPendingPermissionRequest,
      isProcessing,
    ]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

/**
 * 获取快捷键列表（用于帮助/设置展示）
 */
export function getShortcutsList(): KeyboardShortcut[] {
  return DEFAULT_SHORTCUTS;
}

/**
 * 格式化快捷键显示（根据平台）
 */
export function formatShortcut(shortcut: KeyboardShortcut): string {
  const isMac = typeof navigator !== 'undefined' &&
                navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  return isMac ? shortcut.keyMac : shortcut.keyWin;
}

export default useKeyboardShortcuts;
