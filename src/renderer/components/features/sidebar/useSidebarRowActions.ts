import React, { useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import type { ConfigScopeSummary } from '@shared/contract/configScope';
import type { StructuredReplay } from '@shared/contract/evaluation';
import type { SessionWithMeta } from '../../../stores/sessionStore';
import type { ToastType } from '../../../stores/uiStore';
import type { Translations } from '../../../i18n';
import ipcService from '../../../services/ipcService';
import { createLogger } from '../../../utils/logger';
import { getDisplaySessionTitle } from '../../../utils/sessionPresentation';
import { openSessionReplayEvidenceTarget } from '../../../utils/openSessionReplayEvidence';
import { type SessionReplayEvidence } from '../../../utils/sessionReplayEvidence';
import { copyPathToClipboard, openExternalLink } from '../../../utils/platform';

const logger = createLogger('Sidebar');

function dirname(filePath: string): string | null {
  const index = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (index <= 0) return null;
  return filePath.slice(0, index);
}

function joinChildPath(basePath: string, childName: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  return `${basePath.replace(/[\\/]+$/, '')}${separator}${childName}`;
}

export function resolveRuntimeLogsDir(configScope: ConfigScopeSummary | null | undefined): string | null {
  const runtimeLayer = configScope?.layers.find((layer) => layer.id === 'runtime');
  const runtimeFilePath = runtimeLayer?.items.find((item) => item.id === 'runtime-app-settings')?.path
    ?? runtimeLayer?.items.find((item) => item.id === 'runtime-db')?.path;
  if (!runtimeFilePath || runtimeFilePath === 'app bundle') return null;
  const runtimeDir = dirname(runtimeFilePath);
  return runtimeDir ? joinChildPath(runtimeDir, 'logs') : null;
}

export interface SidebarReplayDialogState {
  sessionId: string;
  sessionTitle: string;
  replay: StructuredReplay;
}

export interface SidebarContextMenuState {
  x: number;
  y: number;
  session: SessionWithMeta;
}

export interface UseSidebarRowActionsParams {
  showToast: (type: ToastType, message: string, duration?: number) => string;
  canOpenSessionReplay: boolean;
  setReplayDialog: Dispatch<SetStateAction<SidebarReplayDialogState | null>>;
  setContextMenu: Dispatch<SetStateAction<SidebarContextMenuState | null>>;
  renamingId: string | null;
  renameValue: string;
  setRenamingId: Dispatch<SetStateAction<string | null>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  renameSession: (sessionId: string, title: string) => void;
  t: Translations;
}

export interface SidebarRowActions {
  saveExportToDownloads: (fileName: string, content: string) => Promise<void>;
  openRuntimeLogsFolder: () => Promise<boolean>;
  handleOpenSessionReplay: (session: SessionWithMeta) => Promise<void>;
  handleOpenReplayEvidence: (session: SessionWithMeta, evidence: SessionReplayEvidence) => Promise<void>;
  handleContextMenu: (e: React.MouseEvent, session: SessionWithMeta) => void;
  handleDoubleClick: (e: React.MouseEvent, session: SessionWithMeta) => void;
  handleRenameSubmit: () => void;
  handleRenameKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * Sidebar 会话行级交互 handler 集合：右键菜单、内联重命名、Replay 打开与证据跳转、
 * 导出落盘、运行日志目录打开，以及重命名输入框自动聚焦 effect。从 `Sidebar` 巨型组件抽出。
 * 对应 state（contextMenu / replayDialog / renamingId / renameValue）仍留组件，setter 经
 * params 注入——useState 渲染顺序不变，零行为改动。
 */
export function useSidebarRowActions(params: UseSidebarRowActionsParams): SidebarRowActions {
  const {
    showToast,
    canOpenSessionReplay,
    setReplayDialog,
    setContextMenu,
    renamingId,
    renameValue,
    setRenamingId,
    setRenameValue,
    renameInputRef,
    renameSession,
    t,
  } = params;
  const menu = t.sessionMenu;

  // 重命名 input 聚焦
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId, renameInputRef]);

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, [setContextMenu]);

  // 导出落盘统一走主进程写「下载」文件夹 + 访达定位（webview 另存为对话框在
  // 打包态会静默失败，见 workspace.ipc handleSaveTextToDownloads 注释）
  const saveExportToDownloads = useCallback(async (fileName: string, content: string) => {
    const saved = await window.domainAPI?.invoke<{ filePath: string }>(
      IPC_DOMAINS.WORKSPACE,
      'saveTextToDownloads',
      { fileName, content },
    );
    if (!saved?.success || !saved.data?.filePath) {
      throw new Error(saved?.error?.message || 'Failed to save export');
    }
    showToast('success', menu.savedToDownloads.replace('{fileName}', fileName));
    void window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'showItemInFolder', {
      filePath: saved.data.filePath,
    });
  }, [showToast, menu]);

  const openRuntimeLogsFolder = useCallback(async (): Promise<boolean> => {
    try {
      const scope = await window.domainAPI?.invoke<ConfigScopeSummary>(
        IPC_DOMAINS.WORKSPACE,
        'getConfigScope',
      );
      if (!scope?.success) {
        throw new Error(scope?.error?.message || 'Failed to resolve app data directory');
      }
      const logsDir = resolveRuntimeLogsDir(scope.data);
      if (!logsDir) {
        throw new Error('Failed to resolve logs directory');
      }
      const opened = await window.domainAPI?.invoke(
        IPC_DOMAINS.WORKSPACE,
        'openPath',
        { filePath: logsDir },
      );
      if (opened && !opened.success) {
        throw new Error(opened.error?.message || 'Failed to open logs directory');
      }
      return true;
    } catch (error) {
      logger.warn('Failed to open runtime logs folder', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, []);

  const handleOpenSessionReplay = useCallback(async (session: SessionWithMeta) => {
    if (!canOpenSessionReplay) {
      showToast('warning', menu.replayAdminOnlyToast);
      return;
    }

    try {
      const replay = await ipcService.invoke(IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA, session.id) as StructuredReplay | null;
      if (!replay) {
        showToast('warning', menu.replayEmpty);
        return;
      }
      setReplayDialog({
        sessionId: session.id,
        sessionTitle: getDisplaySessionTitle(session.title),
        replay,
      });
    } catch (error) {
      logger.error('Failed to open session replay', error);
      showToast('error', menu.openReplayFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [canOpenSessionReplay, setReplayDialog, showToast, menu]);

  const handleOpenReplayEvidence = useCallback(async (
    session: SessionWithMeta,
    evidence: SessionReplayEvidence,
  ) => {
    await openSessionReplayEvidenceTarget(evidence, {
      openSessionReplay: () => handleOpenSessionReplay(session),
      openPath: async (filePath) => {
        const opened = await window.domainAPI?.invoke(
          IPC_DOMAINS.WORKSPACE,
          'openPath',
          { filePath },
        );
        if (opened && !opened.success) {
          throw new Error(opened.error?.message || 'Failed to open evidence file');
        }
      },
      openExternal: openExternalLink,
      copyText: copyPathToClipboard,
      notify: showToast,
    });
  }, [handleOpenSessionReplay, showToast]);

  // 双击开始重命名
  const handleDoubleClick = useCallback((e: React.MouseEvent, session: SessionWithMeta) => {
    e.preventDefault();
    e.stopPropagation();
    setRenamingId(session.id);
    setRenameValue(getDisplaySessionTitle(session.title));
  }, [setRenamingId, setRenameValue]);

  // 提交重命名
  const handleRenameSubmit = useCallback(() => {
    if (renamingId && renameValue.trim()) {
      renameSession(renamingId, renameValue.trim());
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renamingId, renameValue, renameSession, setRenamingId, setRenameValue]);

  // 重命名按键
  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  }, [handleRenameSubmit, setRenamingId, setRenameValue]);

  return {
    saveExportToDownloads,
    openRuntimeLogsFolder,
    handleOpenSessionReplay,
    handleOpenReplayEvidence,
    handleContextMenu,
    handleDoubleClick,
    handleRenameSubmit,
    handleRenameKeyDown,
  };
}
