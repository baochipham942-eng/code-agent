// ============================================================================
// Keyboard Shortcuts Hook - 全局快捷键
// 支持 10+ 常用操作
// ============================================================================

import { useEffect, useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useAppStore } from '../stores/appStore';
import { useMessageActionStore } from '../stores/messageActionStore';
import { createLogger } from '../utils/logger';
import { shouldTriggerBareComposerShortcut } from '../utils/composerShortcuts';
import {
  KEYBINDING_DEFINITIONS,
  KEYBINDING_DEFINITION_BY_ID,
  eventToAccelerator,
  formatShortcutForDisplay,
  normalizeAccelerator,
  type KeybindingActionId,
  type KeybindingCategory,
} from '@shared/keybindings';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../services/ipcService';
import { useKeybindingsSettings } from './useKeybindingsSettings';

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
  /** 兼容旧配置字段：清空对话不再默认绑定 Ctrl/Cmd+K */
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

const SHORTCUT_CATEGORY_BY_KEYBINDING_CATEGORY: Record<KeybindingCategory, KeyboardShortcut['category']> = {
  global: 'navigation',
  sessionEditing: 'editing',
  delivery: 'view',
  workbench: 'view',
  settings: 'navigation',
};

const COMMAND_PALETTE_COMPAT_ACCELERATORS = {
  darwin: ['Cmd+Shift+P'],
  win32: ['Ctrl+Shift+P'],
  linux: ['Ctrl+Shift+P'],
} as const;

const TAURI_UNSUPPORTED_GLOBAL_ACCELERATORS = new Set(['Cmd+Cmd']);

interface GlobalHotkeyBindingPayload {
  actionId: KeybindingActionId;
  accelerator: string;
}

interface GlobalHotkeyEventPayload {
  actionId: KeybindingActionId;
  accelerator: string;
}

interface GlobalHotkeyRegistrationResult {
  actionId: KeybindingActionId;
  accelerator: string;
  registered: boolean;
  error?: string | null;
}

function isInputTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element?.tagName === 'INPUT'
    || element?.tagName === 'TEXTAREA'
    || element?.isContentEditable
  );
}

async function invokeTauriCommand<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke<R>(cmd: string, args?: Record<string, unknown>): Promise<R> };
  }).__TAURI_INTERNALS__;
  if (!internals) return null;
  return internals.invoke<T>(command, args);
}

function isTauriRuntime(): boolean {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

// ============================================================================
// Default Shortcuts
// ============================================================================

export const DEFAULT_SHORTCUTS: KeyboardShortcut[] = KEYBINDING_DEFINITIONS.map((definition) => ({
  id: definition.id,
  label: definition.label,
  keyMac: formatShortcutForDisplay(definition.defaultHotkeys.darwin, 'darwin'),
  keyWin: formatShortcutForDisplay(definition.defaultHotkeys.win32, 'win32'),
  description: definition.description,
  category: SHORTCUT_CATEGORY_BY_KEYBINDING_CATEGORY[definition.category],
  enabled: definition.enabledByDefault,
}));

// ============================================================================
// Hook
// ============================================================================

/**
 * 全局快捷键 Hook
 *
 * 支持以下快捷键：
 * - Cmd/Ctrl+N: 新建会话
 * - Cmd/Ctrl+B: 移至后台
 * - Cmd/Ctrl+K: 命令面板
 * - Cmd/Ctrl+L: 聚焦输入框
 * - Cmd/Ctrl+,: 打开设置
 * - Cmd/Ctrl+/: 切换侧边栏
 * - Cmd/Ctrl+D: 切换 DAG 面板
 * - Cmd/Ctrl+E: 切换工作区
 * - Cmd/Ctrl+[: 上一个会话
 * - Cmd/Ctrl+]: 下一个会话
 * - Cmd/Ctrl+Shift+P: 命令面板（兼容旧入口）
 * - Escape: 取消操作
 */
export function useKeyboardShortcuts(config: KeyboardShortcutsConfig = {}): void {
  const {
    enableBackground = true,
    enableNewSession = true,
    enableSettings = true,
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
    openSettingsTab,
    setSidebarCollapsed,
    sidebarCollapsed,
    setShowDAGPanel,
    showDAGPanel,
    setShowWorkspace,
    showWorkspace,
    workbenchTabs,
    openWorkbenchTab,
    closeWorkbenchTab,
    setTaskPanelTab,
    setShowCapturePanel,
    setShowBrowserSurfacePanel,
    setShowComputerUsePanel,
    setShowFileExplorer,
    openWorkspacePreview,
    pendingPermissionRequest,
    setPendingPermissionRequest,
  } = useAppStore();
  const { keybindings, platform } = useKeybindingsSettings();

  const actionByAccelerator = useMemo(() => {
    const map = new Map<string, KeybindingActionId[]>();
    const add = (accelerator: string | null | undefined, actionId: KeybindingActionId) => {
      const normalized = normalizeAccelerator(accelerator, platform);
      if (!normalized) return;
      const existing = map.get(normalized) || [];
      if (!existing.includes(actionId)) existing.push(actionId);
      map.set(normalized, existing);
    };

    for (const definition of KEYBINDING_DEFINITIONS) {
      const binding = keybindings.bindings[definition.id];
      if (!binding?.enabled || !binding.accelerator) continue;
      add(binding.accelerator, definition.id);
    }

    const commandPaletteBinding = keybindings.bindings['commandPalette.open'];
    if (commandPaletteBinding?.enabled) {
      for (const accelerator of COMMAND_PALETTE_COMPAT_ACCELERATORS[platform]) {
        add(accelerator, 'commandPalette.open');
      }
    }

    return map;
  }, [keybindings, platform]);

  const globalHotkeyBindings = useMemo<GlobalHotkeyBindingPayload[]>(() => {
    if (keybindings.globalHotkeysEnabled === false) return [];

    const bindings: GlobalHotkeyBindingPayload[] = [];
    for (const definition of KEYBINDING_DEFINITIONS) {
      if (definition.scope !== 'global') continue;
      const binding = keybindings.bindings[definition.id];
      if (!binding?.enabled || !binding.accelerator) continue;
      const accelerator = normalizeAccelerator(binding.accelerator, platform);
      if (!accelerator || TAURI_UNSUPPORTED_GLOBAL_ACCELERATORS.has(accelerator)) continue;
      bindings.push({ actionId: definition.id, accelerator });
    }
    return bindings;
  }, [keybindings, platform]);

  // 获取当前会话在列表中的索引
  const currentSessionIndex = useMemo(() => {
    if (!currentSessionId) return -1;
    return sessions.findIndex(s => s.id === currentSessionId);
  }, [currentSessionId, sessions]);

  const runAction = useCallback(
    async (actionId: KeybindingActionId, event?: KeyboardEvent): Promise<boolean> => {
      const isInputField = event ? isInputTarget(event.target) : false;

      switch (actionId) {
        case 'session.stop':
          if (!enableCancel) return false;
          if (pendingPermissionRequest) {
            setPendingPermissionRequest(null);
            return true;
          }
          if (useAppStore.getState().showSettings) {
            setShowSettings(false);
            return true;
          }
          if (customHandlers.cancel) {
            await customHandlers.cancel();
            return true;
          }
          return false;

        case 'commandPalette.open':
          logger.info('Shortcut: Command palette');
          if (customHandlers.commandPalette) {
            await customHandlers.commandPalette();
          } else {
            window.dispatchEvent(new CustomEvent('app:openCommandPalette'));
          }
          return true;

        case 'session.new':
          if (!enableNewSession) return false;
          logger.info('Shortcut: New session');
          await createSession('新对话');
          return true;

        case 'session.moveToBackground':
          if (!enableBackground || !currentSessionId || !isSessionRunning(currentSessionId)) return false;
          logger.info('Shortcut: Move to background', { sessionId: currentSessionId });
          if (await moveToBackground(currentSessionId)) {
            await createSession('新对话');
          }
          return true;

        case 'settings.open':
          if (!enableSettings) return false;
          logger.info('Shortcut: Open settings');
          setShowSettings(true);
          return true;

        case 'settings.keybindings':
          openSettingsTab('keybindings');
          return true;

        case 'settings.mcp':
          openSettingsTab('mcp');
          return true;

        case 'settings.skills':
          openSettingsTab('skills');
          return true;

        case 'settings.plugins':
          openSettingsTab('plugins');
          return true;

        case 'settings.usage':
          openSettingsTab('memory');
          return true;

        case 'composer.focus': {
          if (!enableFocusInput) return false;
          logger.info('Shortcut: Focus input');
          const inputEl = document.querySelector('[data-chat-input]') as HTMLTextAreaElement | null;
          inputEl?.focus();
          return true;
        }

        case 'composer.slashMenu': {
          // 裸单字符触发(默认 '/')时做焦点门控：仅在 composer 聚焦且输入为空/光标行首
          // 才作为命令；否则返回 false(不 preventDefault)，让 '/' 正常输入。
          // 带修饰键的 accelerator 与输入不冲突，照常触发。
          const bareKey = !!event && event.key.length === 1
            && !event.metaKey && !event.ctrlKey && !event.altKey;
          if (bareKey) {
            const inputEl = document.querySelector('[data-chat-input]') as HTMLTextAreaElement | null;
            const composerFocused = !!inputEl && document.activeElement === inputEl;
            if (!shouldTriggerBareComposerShortcut({
              composerFocused,
              value: inputEl?.value ?? '',
            })) {
              return false;
            }
          }
          window.dispatchEvent(new CustomEvent('app:openSlashMenu'));
          return true;
        }

        case 'sidebar.toggle':
          if (!enableToggleSidebar) return false;
          logger.info('Shortcut: Toggle sidebar');
          setSidebarCollapsed(!sidebarCollapsed);
          return true;

        case 'dag.toggle':
          if (!enableToggleDAG || isInputField) return false;
          logger.info('Shortcut: Toggle DAG panel');
          setShowDAGPanel(!showDAGPanel);
          return true;

        case 'workspace.toggle':
          if (!enableToggleWorkspace || isInputField) return false;
          logger.info('Shortcut: Toggle workspace');
          setShowWorkspace(!showWorkspace);
          return true;

        case 'statusRail.toggle':
          logger.info('Shortcut: Toggle StatusRail');
          if (workbenchTabs.includes('task')) {
            closeWorkbenchTab('task');
          } else {
            openWorkbenchTab('task');
            setTaskPanelTab('monitor');
          }
          return true;

        case 'session.previous':
          if (!enableSwitchSession || sessions.length <= 1) return false;
          await switchSession(sessions[currentSessionIndex > 0 ? currentSessionIndex - 1 : sessions.length - 1].id);
          return true;

        case 'session.next':
          if (!enableSwitchSession || sessions.length <= 1) return false;
          await switchSession(sessions[currentSessionIndex < sessions.length - 1 ? currentSessionIndex + 1 : 0].id);
          return true;

        case 'session.clear':
          if (useAppStore.getState().isProcessing) return false;
          if (window.confirm('清空当前会话消息？')) {
            clearCurrentSession();
          }
          return true;

        case 'session.compact':
          if (isInputField || !customHandlers.triggerCompact) return false;
          await customHandlers.triggerCompact();
          return true;

        case 'voice.toggle':
          await ipcService.unsafeInvoke(IPC_CHANNELS.VOICE_PASTE_TOGGLE);
          return true;

        case 'appshot.capture':
          if (await invokeTauriCommand('appshots_trigger')) return true;
          setShowCapturePanel(true);
          return true;

        case 'browser.open':
          setShowBrowserSurfacePanel(true);
          return true;

        case 'computerUse.open':
          setShowComputerUsePanel(true);
          return true;

        case 'replay.open':
          openWorkbenchTab('task');
          setTaskPanelTab('monitor');
          return true;

        case 'reviewQueue.open':
          openWorkbenchTab('task');
          setTaskPanelTab('orchestration');
          return true;

        case 'files.attach':
          setShowFileExplorer(true);
          return true;

        case 'artifacts.open':
        case 'artifacts.preview':
        case 'artifacts.export':
        case 'artifacts.copy':
        case 'artifacts.previousVersion':
        case 'artifacts.nextVersion':
          openWorkspacePreview();
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent(`app:${actionId}`));
          });
          return true;

        case 'app.quickAsk':
          window.dispatchEvent(new CustomEvent('app:quickAsk'));
          return true;

        case 'session.retry':
          // 重新生成最后一条助手回复——给「这条不行，重来」一个常驻键盘入口，不必 hover 到操作条。
          return useMessageActionStore.getState().regenerateLast();

        case 'app.toggle':
        case 'composer.send':
        case 'composer.newline':
        case 'session.continue':
          return false;
      }
    },
    [
      enableBackground,
      enableNewSession,
      enableSettings,
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
      openSettingsTab,
      setSidebarCollapsed,
      sidebarCollapsed,
      setShowDAGPanel,
      showDAGPanel,
      setShowWorkspace,
      showWorkspace,
      workbenchTabs,
      openWorkbenchTab,
      closeWorkbenchTab,
      setTaskPanelTab,
      setShowCapturePanel,
      setShowBrowserSurfacePanel,
      setShowComputerUsePanel,
      setShowFileExplorer,
      openWorkspacePreview,
      pendingPermissionRequest,
      setPendingPermissionRequest,
    ]
  );

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      const accelerator = eventToAccelerator(event, platform);
      if (!accelerator) return;
      const actionIds = actionByAccelerator.get(accelerator);
      if (!actionIds?.length) return;
      if (actionIds.length > 1) {
        logger.warn('Shortcut ignored because multiple actions share the same accelerator', {
          accelerator,
          actionIds,
        });
        return;
      }

      const definition = KEYBINDING_DEFINITION_BY_ID.get(actionIds[0]);
      if (
        definition?.scope === 'global'
        && keybindings.globalHotkeysEnabled !== false
        && isTauriRuntime()
      ) {
        return;
      }
      const handled = await runAction(actionIds[0], event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    [actionByAccelerator, keybindings.globalHotkeysEnabled, platform, runAction]
  );

  useEffect(() => {
    void (async () => {
      const results = await invokeTauriCommand<GlobalHotkeyRegistrationResult[]>(
        'keybindings_set_global_hotkeys',
        { bindings: globalHotkeyBindings }
      );
      for (const result of results || []) {
        if (!result.registered) {
          logger.warn('Failed to register global hotkey', {
            actionId: result.actionId,
            accelerator: result.accelerator,
            error: result.error,
          });
        }
      }
    })();
  }, [globalHotkeyBindings]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      if (!isTauriRuntime()) return;
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<GlobalHotkeyEventPayload>('keybindings:global_hotkey', (event) => {
          if (cancelled) return;
          void runAction(event.payload.actionId);
        });
        cleanup = unlisten;
      } catch (error) {
        logger.warn('Failed to listen for global hotkey events', { error });
      }
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [runAction]);

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
