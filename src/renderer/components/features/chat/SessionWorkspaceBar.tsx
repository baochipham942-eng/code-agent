import React from 'react';
import type { SessionWorkbenchSnapshot } from '@shared/contract/sessionWorkspace';
import type { SessionStatusPresentation } from '../../../utils/sessionPresentation';
import { RotateCcw, Download, FolderOpen, TimerReset, Eye, ClipboardList } from 'lucide-react';

interface SessionWorkspaceBarProps {
  title: string;
  status: SessionStatusPresentation;
  activityLabel: string;
  turnCount: number;
  snapshot?: SessionWorkbenchSnapshot;
  workingDirectory?: string | null;
  currentWorkingDirectory?: string | null;
  canResume?: boolean;
  canMoveToBackground?: boolean;
  isInReviewQueue?: boolean;
  onResume?: () => void;
  onMoveToBackground?: () => void;
  onAddToReviewQueue?: () => void;
  onOpenReplay?: () => void;
  onExportMarkdown?: () => void;
  onReopenWorkspace?: () => void;
}

export const SessionWorkspaceBar: React.FC<SessionWorkspaceBarProps> = ({
  title,
  status,
  activityLabel,
  turnCount,
  snapshot,
  workingDirectory,
  currentWorkingDirectory,
  canResume = false,
  canMoveToBackground = false,
  isInReviewQueue = false,
  onResume,
  onMoveToBackground,
  onAddToReviewQueue,
  onOpenReplay,
  onExportMarkdown,
  onReopenWorkspace,
}) => {
  const showReopenWorkspace = Boolean(workingDirectory) && workingDirectory !== currentWorkingDirectory;

  return (
    <div className="mx-4 mt-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-medium text-zinc-100">{title}</h2>
            <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.toneClassName}`}>
              {status.label}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
            <span>{turnCount > 0 ? `${turnCount} 轮` : '0 轮'}</span>
            <span>·</span>
            <span>{activityLabel || '刚刚'}</span>
            <span>·</span>
            <span className="truncate">{snapshot?.summary || '纯对话'}</span>
          </div>
          {workingDirectory && (
            <div className="mt-1 truncate text-[11px] text-zinc-600">{workingDirectory}</div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {canResume && onResume && (
            <button
              type="button"
              onClick={onResume}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              恢复执行
            </button>
          )}
          {canMoveToBackground && onMoveToBackground && (
            <button
              type="button"
              onClick={onMoveToBackground}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <TimerReset className="h-3.5 w-3.5" />
              移到后台
            </button>
          )}
          {onOpenReplay && (
            <button
              type="button"
              onClick={onOpenReplay}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <Eye className="h-3.5 w-3.5" />
              打开 Replay
            </button>
          )}
          {onAddToReviewQueue && (
            <button
              type="button"
              onClick={onAddToReviewQueue}
              disabled={isInReviewQueue}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors ${
                isInReviewQueue
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
                  : 'border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:text-zinc-100'
              }`}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              {isInReviewQueue ? '已在 Review' : '加入 Review'}
            </button>
          )}
          {onExportMarkdown && (
            <button
              type="button"
              onClick={onExportMarkdown}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <Download className="h-3.5 w-3.5" />
              导出 Markdown
            </button>
          )}
          {showReopenWorkspace && onReopenWorkspace && (
            <button
              type="button"
              onClick={onReopenWorkspace}
              className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              恢复工作区
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SessionWorkspaceBar;
