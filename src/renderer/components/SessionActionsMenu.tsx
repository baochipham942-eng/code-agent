// ============================================================================
// SessionActionsMenu — TitleBar 里的会话动作菜单（... popover）
// ============================================================================
//
// 把原本挂在聊天区顶部 SessionWorkspaceBar 的一行按钮收进 popover：
// 恢复执行 / 移到后台 / 打开 Replay / 加入 Review / 导出 Markdown / 恢复工作区。
// 自己从 store 拿当前会话 + 实现 handler，不从 TitleBar 收 props。
//
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MoreHorizontal, RotateCcw, TimerReset, Eye, ClipboardList, Download, FolderOpen, Play,
} from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTaskStore } from '../stores/taskStore';
import { useEvalCenterStore } from '../stores/evalCenterStore';
import { getSessionStatusPresentation } from '../utils/sessionPresentation';
import { IPC_DOMAINS } from '@shared/ipc';
import { IconButton } from './primitives';

export const SessionActionsMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const appWorkingDirectory = useAppStore((s) => s.workingDirectory);
  const setAppWorkingDirectory = useAppStore((s) => s.setWorkingDirectory);
  const setShowEvalCenter = useAppStore((s) => s.setShowEvalCenter);
  const openDevServerLauncher = useAppStore((s) => s.openDevServerLauncher);

  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionRuntimes = useSessionStore((s) => s.sessionRuntimes);
  const backgroundTasks = useSessionStore((s) => s.backgroundTasks);
  const moveToBackground = useSessionStore((s) => s.moveToBackground);

  const sessionStates = useTaskStore((s) => s.sessionStates);
  const reviewQueue = useEvalCenterStore((s) => s.reviewQueue);
  const enqueueReviewItem = useEvalCenterStore((s) => s.enqueueReviewItem);

  const currentSession = sessions.find((s) => s.id === currentSessionId) || null;

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

  const currentBackgroundTask = backgroundTasks.find((t) => t.sessionId === currentSessionId) || undefined;
  const currentSessionRuntime = currentSessionId ? sessionRuntimes.get(currentSessionId) : undefined;
  const currentSessionState = currentSessionId ? sessionStates[currentSessionId] : null;
  const currentSessionStatus = getSessionStatusPresentation({
    backgroundTask: currentBackgroundTask,
    runtime: currentSessionRuntime,
    taskState: currentSessionState,
    messageCount: currentSession?.messageCount,
  });

  const canResume = currentSessionStatus.kind === 'paused';
  const canMoveToBackground = currentSessionStatus.kind === 'live';
  const isInReviewQueue = currentSessionId
    ? reviewQueue.some((item) => item.sessionId === currentSessionId)
    : false;
  const sessionWorkingDirectory = currentSession?.workingDirectory?.trim() || null;
  const showReopenWorkspace = Boolean(sessionWorkingDirectory)
    && sessionWorkingDirectory !== appWorkingDirectory;

  const handleResume = useCallback(async () => {
    if (!currentSessionId) return;
    close();
    await window.domainAPI?.invoke(IPC_DOMAINS.AGENT, 'resume', { sessionId: currentSessionId });
  }, [currentSessionId, close]);

  const handleMoveToBackground = useCallback(async () => {
    if (!currentSessionId) return;
    close();
    await moveToBackground(currentSessionId);
  }, [currentSessionId, moveToBackground, close]);

  const handleOpenReplay = useCallback(() => {
    if (!currentSessionId) return;
    close();
    setShowEvalCenter(true, undefined, currentSessionId);
  }, [currentSessionId, setShowEvalCenter, close]);

  const handleAddToReviewQueue = useCallback(async () => {
    if (!currentSessionId || !currentSession) return;
    close();
    await enqueueReviewItem({
      sessionId: currentSessionId,
      sessionTitle: currentSession.title,
      reason: 'manual_review',
      enqueueSource: 'current_session_bar',
    });
  }, [currentSession, currentSessionId, enqueueReviewItem, close]);

  const handleExportMarkdown = useCallback(async () => {
    if (!currentSessionId) return;
    close();
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
  }, [currentSessionId, close]);

  const handleReopenWorkspace = useCallback(async () => {
    if (!sessionWorkingDirectory) return;
    close();
    const response = await window.domainAPI?.invoke<string | null>(
      IPC_DOMAINS.WORKSPACE,
      'setCurrent',
      { dir: sessionWorkingDirectory },
    );
    if (!response?.success) {
      throw new Error(response?.error?.message || 'Failed to restore workspace');
    }
    setAppWorkingDirectory(response.data || sessionWorkingDirectory);
  }, [sessionWorkingDirectory, setAppWorkingDirectory, close]);

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
      label: '恢复执行',
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      onClick: handleResume,
    });
  }
  if (canMoveToBackground) {
    items.push({
      key: 'bg',
      label: '移到后台',
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
    label: '打开 Replay',
    icon: <Eye className="h-3.5 w-3.5" />,
    onClick: handleOpenReplay,
  });
  items.push({
    key: 'review',
    label: isInReviewQueue ? '已在 Review' : '加入 Review',
    icon: <ClipboardList className="h-3.5 w-3.5" />,
    onClick: handleAddToReviewQueue,
    disabled: isInReviewQueue,
    tone: isInReviewQueue ? 'active' : 'default',
  });
  items.push({
    key: 'export',
    label: '导出 Markdown',
    icon: <Download className="h-3.5 w-3.5" />,
    onClick: handleExportMarkdown,
  });
  if (showReopenWorkspace) {
    items.push({
      key: 'reopen',
      label: '恢复工作区',
      icon: <FolderOpen className="h-3.5 w-3.5" />,
      onClick: handleReopenWorkspace,
    });
  }

  if (items.length === 0) return null;

  return (
    <div ref={wrapperRef} className="relative window-no-drag">
      <IconButton
        icon={<MoreHorizontal className="w-4 h-4" />}
        aria-label="会话动作"
        onClick={() => setOpen((v) => !v)}
        variant="ghost"
        size="md"
        windowNoDrag
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
    </div>
  );
};

export default SessionActionsMenu;
