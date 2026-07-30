// ============================================================================
// TurnDiffSummary - 聚合 turn 内所有 Edit/Write 变更，头部可一键 Undo
// 参照 Codex 桌面应用的「N files changed +X -Y」消息级 diff 卡片
// ============================================================================

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Undo2, Check, Loader2 } from 'lucide-react';
import type { RestoreWorkspaceFilesAtCheckpointResult } from '@shared/contract/fileRestore';
import type { TraceTurn } from '@shared/contract/trace';
import { IPC_CHANNELS, IPC_DOMAINS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { toast } from '../../../../hooks/useToast';
import { DiffView } from '../../../DiffView';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { buildTurnFileChanges } from '../../../../utils/turnDiffSummary';
import {
  readTurnDiffExpansion,
  writeTurnDiffExpansion,
} from '../../../../utils/turnDiffExpansionState';
import { useI18n } from '../../../../hooks/useI18n';

interface CheckpointListItem {
  id: string;
  timestamp: number;
  messageId: string;
  fileCount: number;
}

interface TurnDiffSummaryProps {
  turn: TraceTurn;
}

type UndoState = 'idle' | 'done' | 'error';

export const TurnDiffSummary: React.FC<TurnDiffSummaryProps> = ({ turn }) => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  // 会话自己的工作目录优先——多根/切目录时全局那个不一定是这轮改动所在的根
  const workingDirectory = useSessionStore(
    (s) => (s.sessions ?? []).find((session) => session.id === s.currentSessionId)?.workingDirectory ?? null,
  );
  const { t } = useI18n();

  // 展开态提到组件外（模块级 Map，按 sessionId:turnId 键控）：消息流是虚拟列表，
  // 执行中自动滚动会卸载/重挂载本卡，组件内 useState 会被重置（X5.5-B2 根因）。
  // 只被用户手势改写——程序不主动展开/收起，执行中默认收起、终态后一次性定型。
  const expansionKey = `${currentSessionId ?? 'no-session'}:${turn.turnId}`;
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => readTurnDiffExpansion(expansionKey),
  );
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoState, setUndoState] = useState<UndoState>('idle');
  const [undoError, setUndoError] = useState<string | null>(null);
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // 聚合 turn.nodes 里成功的 Edit/Write，按 filePath 合并（纯逻辑抽到 utils 便于单测）
  const fileChanges = useMemo(() => buildTurnFileChanges(turn), [turn]);

  // 查 checkpoint 找本 turn 的 rewind 锚点 messageId
  useEffect(() => {
    if (!currentSessionId) return;
    if (turn.status === 'streaming') return;
    if (fileChanges.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const list = (await ipcService.invoke(
          IPC_CHANNELS.CHECKPOINT_LIST,
          currentSessionId
        )) as CheckpointListItem[] | undefined;
        if (cancelled || !Array.isArray(list) || list.length === 0) return;

        const endTime = turn.endTime ?? Number.MAX_SAFE_INTEGER;
        const inRange = list.filter(
          (cp) => cp.timestamp >= turn.startTime && cp.timestamp <= endTime
        );
        if (inRange.length === 0) return;

        inRange.sort((a, b) => a.timestamp - b.timestamp);
        setAnchorMessageId(inRange[0].messageId);
      } catch {
        // checkpoint 不可用时静默失败，仅影响 Undo 按钮
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentSessionId, turn.startTime, turn.endTime, turn.status, fileChanges.length]);

  const handleUndo = useCallback(async () => {
    if (!currentSessionId || !anchorMessageId) return;
    if (isUndoing || undoState === 'done') return;

    setIsUndoing(true);
    setUndoError(null);
    try {
      const result = await ipcService.invokeDomain<RestoreWorkspaceFilesAtCheckpointResult>(
        IPC_DOMAINS.SESSION,
        'restoreWorkspaceFilesAtCheckpoint',
        {
          sessionId: currentSessionId,
          checkpointMessageId: anchorMessageId,
        },
      );

      if (result.success) {
        setUndoState('done');
      } else {
        const message = 'Rewind failed';
        setUndoState('error');
        setUndoError(message);
        toast.error(t.turnDiff.undoToastFailed.replace('{message}', message));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setUndoState('error');
      setUndoError(message);
      toast.error(t.turnDiff.undoToastFailed.replace('{message}', message));
    } finally {
      setIsUndoing(false);
    }
  }, [currentSessionId, anchorMessageId, isUndoing, undoState]);

  const requestUndo = useCallback(() => {
    if (!currentSessionId || !anchorMessageId || isUndoing || undoState === 'done') return;
    setIsConfirmOpen(true);
  }, [anchorMessageId, currentSessionId, isUndoing, undoState]);

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      // 同步写回组件外存放，重挂载后原样恢复
      writeTurnDiffExpansion(expansionKey, next);
      return next;
    });
  }, [expansionKey]);

  if (fileChanges.length === 0) return null;

  const totalAdded = fileChanges.reduce((s, f) => s + f.added, 0);
  const totalRemoved = fileChanges.reduce((s, f) => s + f.removed, 0);
  const canUndo =
    anchorMessageId !== null &&
    turn.status !== 'streaming' &&
    undoState === 'idle';

  return (
    <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-900/40 overflow-hidden">
      {/* 标题一行说清「做了什么」，增删计数独占第二行——挤在标题右边时它像个编号，
          单独一行才读得出是行数。这一屏里唯一真的动了用户电脑的东西，权重要给够。 */}
      <div className="flex items-start gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-800/40">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-zinc-200">
            {t.turnDiff.filesEdited.replace('{count}', String(fileChanges.length))}
          </div>
          {(totalAdded > 0 || totalRemoved > 0) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs">
              {totalAdded > 0 && <span className="text-emerald-400">+{totalAdded}</span>}
              {totalRemoved > 0 && <span className="text-rose-400">-{totalRemoved}</span>}
            </div>
          )}
        </div>
        {undoState === 'idle' && (
          <button
            onClick={requestUndo}
            disabled={!canUndo || isUndoing}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={
              canUndo
                ? t.turnDiff.undoAllTitle
                : turn.status === 'streaming'
                ? t.turnDiff.sessionRunning
                : t.turnDiff.noCheckpoint
            }
          >
            {isUndoing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Undo2 className="w-3 h-3" />
            )}
            <span>{t.turnDiff.undo}</span>
          </button>
        )}
        {undoState === 'done' && (
          <span className="flex items-center gap-1 px-2 py-0.5 text-xs text-emerald-400">
            <Check className="w-3 h-3" />
            {t.turnDiff.undone}
          </span>
        )}
        {undoState === 'error' && (
          <div className="flex items-center gap-1.5">
            <span
              className="text-xs text-rose-400 truncate max-w-[160px]"
              title={undoError || t.turnDiff.undoFailed}
            >
              {t.turnDiff.undoFailed}
            </span>
            <button
              type="button"
              onClick={requestUndo}
              disabled={isUndoing}
              className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
            >
              {t.common.retry}
            </button>
          </div>
        )}
      </div>

      {/* File list */}
      <div>
        {fileChanges.map((fc) => {
          const expanded = expandedFiles.has(fc.filePath);
          // 相对当前工作目录显示。绝对路径下九成字符是与本次改动无关的前缀，
          // 目录/文件名的明暗分级被那段前缀吃掉，整条读起来就是一坨灰。
          // 完整路径仍留在 title 里——那时它是补充信息，不再是重复。
          const shownPath = workingDirectory && fc.filePath.startsWith(`${workingDirectory}/`)
            ? fc.filePath.slice(workingDirectory.length + 1)
            : fc.filePath;
          const fileName = shownPath.split('/').pop() || shownPath;
          const dirPath = shownPath.slice(
            0,
            Math.max(0, shownPath.length - fileName.length - 1)
          );
          return (
            <div
              key={fc.filePath}
              className="border-b border-zinc-800 last:border-b-0"
            >
              <button
                onClick={() => toggleFile(fc.filePath)}
                aria-expanded={expanded}
                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-zinc-800/50 transition-colors text-left"
              >
                {expanded ? (
                  <ChevronDown className="w-3 h-3 text-zinc-500 flex-shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 text-zinc-500 flex-shrink-0" />
                )}
                <span
                  className="text-xs font-mono truncate flex-1 min-w-0"
                  title={fc.filePath}
                >
                  {dirPath && <span className="text-zinc-600">{dirPath}/</span>}
                  <span className="text-zinc-300">{fileName}</span>
                  {fc.isNewFile && (
                    <span className="ml-2 text-[10px] text-emerald-400/80">
                      {t.turnDiff.newFileBadge}
                    </span>
                  )}
                  {fc.editCount > 1 && (
                    <span className="ml-2 text-[10px] text-zinc-500">
                      ×{fc.editCount}
                    </span>
                  )}
                </span>
                {fc.added > 0 && (
                  <span className="text-xs text-emerald-400 flex-shrink-0">
                    +{fc.added}
                  </span>
                )}
                {fc.removed > 0 && (
                  <span className="text-xs text-rose-400 flex-shrink-0">
                    -{fc.removed}
                  </span>
                )}
              </button>
              {expanded && (
                <div className="px-3 pb-2 bg-zinc-900/30">
                  <DiffView
                    oldText={fc.oldText}
                    newText={fc.newText}
                    fileName={fileName}
                    className="border border-zinc-800 rounded-md overflow-hidden"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ConfirmDialog
        isOpen={isConfirmOpen}
        title={t.turnDiff.confirmTitle}
        message={t.turnDiff.confirmMessage.replace('{count}', String(fileChanges.length))}
        variant="warning"
        confirmText={t.turnDiff.confirmAction}
        onCancel={() => setIsConfirmOpen(false)}
        onConfirm={() => {
          setIsConfirmOpen(false);
          void handleUndo();
        }}
      />
    </div>
  );
};
