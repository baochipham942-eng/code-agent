// ============================================================================
// SessionActionsMenu — TitleBar 里的会话动作菜单（... popover）
// ============================================================================
//
// 把原本挂在聊天区顶部 SessionWorkspaceBar 的一行按钮收进 popover：
// 恢复执行 / 移到后台 / 打开 Replay / 加入 Review / 导出 Markdown / 恢复工作区。
// 自己从 store 拿当前会话 + 实现 handler，不从 TitleBar 收 props。
//
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MoreHorizontal, RotateCcw, TimerReset, Eye, Download, FolderOpen, Play, ClipboardList,
} from 'lucide-react';
import type { StructuredReplay } from '@shared/contract/evaluation';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import { useAppStore } from '../stores/appStore';
import { useAuthStore } from '../stores/authStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useUIStore } from '../stores/uiStore';
import { useBackgroundTaskStore } from '../stores/backgroundTaskStore';
import { useWorkflowStore } from '../stores/workflowStore';
import { getSessionStatusPresentation } from '../utils/sessionPresentation';
import { hasNeedsInputForSession } from '../utils/sessionNeedsInput';
import { canAccessFeature } from '../utils/accessControl';
import { buildSessionReplayContext } from '../utils/sessionReplayContext';
import { openSessionReplayEvidenceTarget } from '../utils/openSessionReplayEvidence';
import { copyPathToClipboard, openExternalLink } from '../utils/platform';
import ipcService from '../services/ipcService';
import { IconButton } from './primitives';
import { SessionReplaySummaryDialog } from './features/sidebar/SessionReplaySummaryDialog';
import { useI18n } from '../hooks/useI18n';

export const SessionActionsMenu: React.FC = () => {
  const { t } = useI18n();
  const sam = t.sessionReplay.sessionActionsMenu;
  const [open, setOpen] = useState(false);
  const [replayDialog, setReplayDialog] = useState<{
    sessionId: string;
    sessionTitle: string;
    replay: StructuredReplay;
  } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const appWorkingDirectory = useAppStore((s) => s.workingDirectory);
  const setAppWorkingDirectory = useAppStore((s) => s.setWorkingDirectory);
  const openDevServerLauncher = useAppStore((s) => s.openDevServerLauncher);
  const openWorkbenchTab = useAppStore((s) => s.openWorkbenchTab);
  const pendingPermissionRequest = useAppStore((s) => s.pendingPermissionRequest);
  const pendingPermissionSessionId = useAppStore((s) => s.pendingPermissionSessionId);
  const queuedPermissionRequests = useAppStore((s) => s.queuedPermissionRequests);

  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionRuntimes = useSessionStore((s) => s.sessionRuntimes);
  const backgroundSessions = useSessionStore((s) => s.backgroundSessions);
  const pendingUserQuestionsBySessionId = useSessionStore((s) => s.pendingUserQuestionsBySessionId);
  const moveToBackground = useSessionStore((s) => s.moveToBackground);

  const sessionStates = useTaskStore((s) => s.sessionStates);
  const workflowRuns = useWorkflowStore((s) => s.runs);
  const durableBackgroundTasks = useBackgroundTaskStore((s) => s.tasks);
  const user = useAuthStore((s) => s.user);
  const showToast = useUIStore((s) => s.showToast);

  const currentSession = sessions.find((s) => s.id === currentSessionId) || null;
  const canOpenReplay = canAccessFeature('eval.replay', user);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const currentBackgroundSession = backgroundSessions.find((session) => session.sessionId === currentSessionId) || undefined;
  const currentSessionRuntime = currentSessionId ? sessionRuntimes.get(currentSessionId) : undefined;
  const currentSessionState = currentSessionId ? sessionStates[currentSessionId] : null;
  const durableWaitingInputSessionIds = useMemo(
    () => new Set(sessions.filter((session) => session.durableWaitingInput === true).map((session) => session.id)),
    [sessions],
  );
  const currentSessionNeedsInput = Boolean(
    currentSessionId &&
    hasNeedsInputForSession(currentSessionId, {
      permissionState: {
        pendingPermissionRequest,
        pendingPermissionSessionId,
        queuedPermissionRequests,
      },
      backgroundTasks: durableBackgroundTasks,
      pendingUserQuestionsBySessionId,
      durableWaitingInputSessionIds,
    }),
  );
  const currentSessionStatus = getSessionStatusPresentation({
    backgroundSession: currentBackgroundSession,
    runtime: currentSessionRuntime,
    taskState: currentSessionState,
    messageCount: currentSession?.messageCount,
    turnCount: currentSession?.turnCount,
    sessionStatus: currentSession?.status,
    hasNeedsInput: currentSessionNeedsInput,
  });

  const canResume = currentSessionStatus.kind === 'paused';
  const canMoveToBackground = currentSessionStatus.kind === 'live';
  const sessionWorkingDirectory = currentSession?.workingDirectory?.trim() || null;
  const showReopenWorkspace = Boolean(sessionWorkingDirectory)
    && sessionWorkingDirectory !== appWorkingDirectory;
  const replayDialogContext = useMemo(
    () => buildSessionReplayContext(replayDialog?.sessionId, workflowRuns, durableBackgroundTasks),
    [durableBackgroundTasks, replayDialog?.sessionId, workflowRuns],
  );

  const handleResume = useCallback(async () => {
    if (!currentSessionId) return;
    close();
    try {
      await window.domainAPI?.invoke(IPC_DOMAINS.AGENT, 'resume', { sessionId: currentSessionId });
    } catch (error) {
      showToast('error', sam.resumeFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [currentSessionId, close, showToast]);

  const handleMoveToBackground = useCallback(async () => {
    if (!currentSessionId) return;
    close();
    await moveToBackground(currentSessionId);
  }, [currentSessionId, moveToBackground, close]);

  const handleExportMarkdown = useCallback(async () => {
    if (!currentSessionId) return;
    close();
    try {
      const response = await window.domainAPI?.invoke<{ markdown: string; suggestedFileName?: string }>(
        IPC_DOMAINS.SESSION,
        'exportMarkdown',
        { sessionId: currentSessionId },
      );
      if (!response?.success || !response.data?.markdown) {
        throw new Error(response?.error?.message || 'Failed to export markdown');
      }
      const blob = new Blob([response.data.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = response.data.suggestedFileName || `session-${currentSessionId}.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast('success', sam.exportMarkdownDone);
    } catch (error) {
      showToast('error', sam.exportMarkdownFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [currentSessionId, close, showToast]);

  const handleReopenWorkspace = useCallback(async () => {
    if (!sessionWorkingDirectory) return;
    close();
    try {
      const response = await window.domainAPI?.invoke<string | null>(
        IPC_DOMAINS.WORKSPACE,
        'setCurrent',
        { dir: sessionWorkingDirectory },
      );
      if (!response?.success) {
        throw new Error(response?.error?.message || 'Failed to restore workspace');
      }
      setAppWorkingDirectory(response.data || sessionWorkingDirectory);
    } catch (error) {
      showToast('error', sam.reopenWorkspaceFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [sessionWorkingDirectory, setAppWorkingDirectory, close, showToast]);

  const handleOpenReplay = useCallback(async () => {
    if (!currentSessionId || !currentSession) return;
    if (!canOpenReplay) {
      showToast('warning', sam.replayAdminOnlyToast);
      return;
    }

    close();
    try {
      const replay = await ipcService.invoke(IPC_CHANNELS.REPLAY_GET_STRUCTURED_DATA, currentSessionId) as StructuredReplay | null;
      if (!replay) {
        showToast('warning', sam.replayNoData);
        return;
      }
      setReplayDialog({
        sessionId: currentSessionId,
        sessionTitle: currentSession.title || sam.untitledSession,
        replay,
      });
    } catch (error) {
      showToast('error', sam.replayOpenFailed.replace('{message}', error instanceof Error ? error.message : String(error)));
    }
  }, [canOpenReplay, close, currentSession, currentSessionId, showToast]);

  const handleOpenReplayEvidence = useCallback(async (
    evidence: typeof replayDialogContext.evidence[number],
  ) => {
    await openSessionReplayEvidenceTarget(evidence, {
      openSessionReplay: () => handleOpenReplay(),
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
  }, [handleOpenReplay, showToast]);

  // 无会话或无可用动作时不渲染
  if (!currentSession) return null;

  type ActionItem = {
    key: string;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    tone?: 'default' | 'active';
  };
  const items: ActionItem[] = [];
  if (canResume) {
    items.push({
      key: 'resume',
      label: sam.resumeLabel,
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      onClick: handleResume,
    });
  }
  if (canMoveToBackground) {
    items.push({
      key: 'bg',
      label: sam.moveToBackgroundLabel,
      icon: <TimerReset className="h-3.5 w-3.5" />,
      onClick: handleMoveToBackground,
    });
  }
  items.push({
    key: 'live-preview',
    label: 'Live Preview…',
    icon: <Play className="h-3.5 w-3.5" />,
    onClick: () => { close(); openDevServerLauncher(); },
  });
  items.push({
    key: 'replay',
    label: canOpenReplay ? sam.replayLabel : sam.replayAdminOnlyLabel,
    icon: <Eye className="h-3.5 w-3.5" />,
    disabled: !canOpenReplay,
    onClick: () => { void handleOpenReplay(); },
  });
  items.push({
    key: 'audit',
    label: sam.replayAuditLabel,
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    onClick: () => { close(); openWorkbenchTab('audit'); },
  });
  items.push({
    key: 'export',
    label: sam.exportMarkdownLabel,
    icon: <Download className="h-3.5 w-3.5" />,
    onClick: handleExportMarkdown,
  });
  if (showReopenWorkspace) {
    items.push({
      key: 'reopen',
      label: sam.reopenWorkspaceLabel,
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      onClick: handleReopenWorkspace,
    });
  }

  if (items.length === 0) return null;

  return (
    <div ref={wrapperRef} className="relative">
      <IconButton
        icon={<MoreHorizontal className="w-4 h-4" />}
        aria-label={sam.menuAria}
        onClick={() => setOpen((v) => !v)}
        variant="ghost"
        size="md"
        className={open ? 'text-zinc-100' : 'text-zinc-400 hover:text-zinc-100'}
      />
      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl backdrop-blur z-40">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              disabled={item.disabled}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                item.tone === 'active'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : item.disabled
                    ? 'text-zinc-500'
                    : 'text-zinc-200 hover:bg-white/[0.06]'
              }`}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
      {replayDialog && (
        <SessionReplaySummaryDialog
          sessionTitle={replayDialog.sessionTitle}
          replay={replayDialog.replay}
          workflowRuns={replayDialogContext.workflowRuns}
          backgroundTasks={replayDialogContext.backgroundTasks}
          evidence={replayDialogContext.evidence}
          onOpenEvidence={(evidence) => { void handleOpenReplayEvidence(evidence); }}
          onClose={() => setReplayDialog(null)}
        />
      )}
    </div>
  );
};

export default SessionActionsMenu;
