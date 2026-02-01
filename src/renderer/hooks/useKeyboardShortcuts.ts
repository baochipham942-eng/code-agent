// ============================================================================
// Keyboard Shortcuts Hook - 全局快捷键
// ============================================================================

import { useEffect, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { createLogger } from '../utils/logger';

const logger = createLogger('KeyboardShortcuts');

/**
 * 全局快捷键配置
 */
export interface KeyboardShortcutsConfig {
  /** 是否启用后台任务快捷键 (Ctrl/Cmd+B) */
  enableBackground?: boolean;
  /** 是否启用新会话快捷键 (Ctrl/Cmd+N) */
  enableNewSession?: boolean;
  /** 是否启用设置快捷键 (Ctrl/Cmd+,) */
  enableSettings?: boolean;
}

/**
 * 全局快捷键 Hook
 *
 * 支持以下快捷键：
 * - Ctrl/Cmd+B: 将当前运行中的会话移至后台
 * - Ctrl/Cmd+N: 创建新会话
 * - Ctrl/Cmd+,: 打开设置
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig = {}): void {
  const {
    enableBackground = true,
    enableNewSession = true,
    enableSettings = true,
  } = config;

  const {
    currentSessionId,
    isSessionRunning,
    moveToBackground,
    createSession,
  } = useSessionStore();

  const { setShowSettings } = useAppStore();

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? event.metaKey : event.ctrlKey;

      if (!modifier) return;

      switch (event.key.toLowerCase()) {
        case 'b':
          // Ctrl/Cmd+B: 移至后台
          if (enableBackground && currentSessionId && isSessionRunning(currentSessionId)) {
            event.preventDefault();
            logger.info('Shortcut: Move to background', { sessionId: currentSessionId });
            const success = await moveToBackground(currentSessionId);
            if (success) {
              // 创建新会话
              await createSession();
            }
          }
          break;

        case 'n':
          // Ctrl/Cmd+N: 新会话
          if (enableNewSession) {
            event.preventDefault();
            logger.info('Shortcut: New session');
            await createSession();
          }
          break;

        case ',':
          // Ctrl/Cmd+,: 设置
          if (enableSettings) {
            event.preventDefault();
            logger.info('Shortcut: Open settings');
            setShowSettings(true);
          }
          break;
      }
    },
    [
      enableBackground,
      enableNewSession,
      enableSettings,
      currentSessionId,
      isSessionRunning,
      moveToBackground,
      createSession,
      setShowSettings,
    ]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
}

export default useKeyboardShortcuts;
