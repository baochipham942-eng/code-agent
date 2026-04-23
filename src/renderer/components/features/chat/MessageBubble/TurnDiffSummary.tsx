// ============================================================================
// TurnDiffSummary - 聚合 turn 内所有 Edit/Write 变更，头部可一键 Undo
// 参照 Codex 桌面应用的「N files changed +X -Y」消息级 diff 卡片
// ============================================================================

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import * as Diff from 'diff';
import { ChevronDown, ChevronRight, Undo2, Check, Loader2 } from 'lucide-react';
import type { TraceTurn } from '@shared/contract/trace';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../../services/ipcService';
import { useSessionStore } from '../../../../stores/sessionStore';
import { DiffView } from '../../../DiffView';

const FILE_WRITE_TOOLS = ['Edit', 'Write', 'edit_file', 'write_file'];

interface FileChange {
  filePath: string;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  isNewFile: boolean;
  editCount: number;
}

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

  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoState, setUndoState] = useState<UndoState>('idle');
  const [undoError, setUndoError] = useState<string | null>(null);
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);

  // 聚合 turn.nodes 里成功的 Edit/Write，按 filePath 合并
  // 对老会话 args 可能缺失，fallback 从 result 字符串解析路径
  const fileChanges = useMemo<FileChange[]>(() => {
    const byPath = new Map<string, FileChange>();

    for (const node of turn.nodes) {
      if (node.type !== 'tool_call' || !node.toolCall) continue;
      const tc = node.toolCall;
      if (!FILE_WRITE_TOOLS.includes(tc.name)) continue;
      if (tc.success === false) continue;

      const args = tc.args || {};
      let filePath = (args.file_path ?? args.path) as string | undefined;

      // Fallback: 从 result 字符串 "Created file: X" / "Updated file: X" 抽取路径
      if (!filePath && typeof tc.result === 'string') {
        const m = tc.result.match(/(?:Created|Updated) file:\s*(.+?)(?:\s+\(|\s*\n|$)/);
        if (m) filePath = m[1].trim();
      }
      if (!filePath && typeof tc.outputPath === 'string') {
        filePath = tc.outputPath;
      }
      if (!filePath) continue;

      let oldText = '';
      let newText = '';
      let isNewFile = false;

      if (tc.name === 'Edit' || tc.name === 'edit_file') {
        oldText = (args.old_string as string) ?? '';
        newText = (args.new_string as string) ?? '';
      } else {
        // Write / write_file：默认视作新建；若 result 显示 "Updated" 则改为修改
        newText = (args.content as string) ?? '';
        isNewFile = true;
        if (typeof tc.result === 'string' && /^Updated file/m.test(tc.result)) {
          isNewFile = false;
        }
      }

      // 空编辑跳过（仅当两者都非空且相等时；两者都空可能是 args 缺失的老会话，仍保留）
      if (oldText && newText && oldText === newText) continue;

      let added = 0;
      let removed = 0;
      if (oldText || newText) {
        const diffChanges = Diff.diffLines(oldText, newText);
        for (const c of diffChanges) {
          const lines = c.value.split('\n').filter((l) => l !== '').length;
          if (c.added) added += lines;
          else if (c.removed) removed += lines;
        }
      }

      const existing = byPath.get(filePath);
      if (existing) {
        existing.added += added;
        existing.removed += removed;
        existing.newText = newText;
        existing.editCount += 1;
      } else {
        byPath.set(filePath, {
          filePath,
          oldText,
          newText,
          added,
          removed,
          isNewFile,
          editCount: 1,
        });
      }
    }

    return Array.from(byPath.values());
  }, [turn]);

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
    if (isUndoing || undoState !== 'idle') return;

    setIsUndoing(true);
    try {
      const result = (await ipcService.invoke(
        IPC_CHANNELS.CHECKPOINT_REWIND,
        currentSessionId,
        anchorMessageId
      )) as { success: boolean; filesRestored: number; error?: string } | undefined;

      if (result?.success) {
        setUndoState('done');
      } else {
        setUndoState('error');
        setUndoError(result?.error || 'Rewind failed');
      }
    } catch (err) {
      setUndoState('error');
      setUndoError(String(err));
    } finally {
      setIsUndoing(false);
    }
  }, [currentSessionId, anchorMessageId, isUndoing, undoState]);

  const toggleFile = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  if (fileChanges.length === 0) return null;

  const totalAdded = fileChanges.reduce((s, f) => s + f.added, 0);
  const totalRemoved = fileChanges.reduce((s, f) => s + f.removed, 0);
  const canUndo =
    anchorMessageId !== null &&
    turn.status !== 'streaming' &&
    undoState === 'idle';

  return (
    <div className="mt-2 rounded-lg border border-zinc-700 bg-zinc-900/40 overflow-hidden">
      {/* Header: N files changed +X -Y + Undo */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-800/40">
        <span className="text-xs text-zinc-300">
          {fileChanges.length} file{fileChanges.length > 1 ? 's' : ''} changed
        </span>
        {totalAdded > 0 && (
          <span className="text-xs text-emerald-400">+{totalAdded}</span>
        )}
        {totalRemoved > 0 && (
          <span className="text-xs text-rose-400">-{totalRemoved}</span>
        )}
        <div className="flex-1" />
        {undoState === 'idle' && (
          <button
            onClick={handleUndo}
            disabled={!canUndo || isUndoing}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title={
              canUndo
                ? '撤销本轮所有文件变更'
                : turn.status === 'streaming'
                ? '会话进行中'
                : '无可用 checkpoint'
            }
          >
            {isUndoing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Undo2 className="w-3 h-3" />
            )}
            <span>Undo</span>
          </button>
        )}
        {undoState === 'done' && (
          <span className="flex items-center gap-1 px-2 py-0.5 text-xs text-emerald-400">
            <Check className="w-3 h-3" />
            Undone
          </span>
        )}
        {undoState === 'error' && (
          <span
            className="text-xs text-rose-400 truncate max-w-[160px]"
            title={undoError || 'Undo failed'}
          >
            Undo failed
          </span>
        )}
      </div>

      {/* File list */}
      <div>
        {fileChanges.map((fc) => {
          const expanded = expandedFiles.has(fc.filePath);
          const fileName = fc.filePath.split('/').pop() || fc.filePath;
          const dirPath = fc.filePath.slice(
            0,
            Math.max(0, fc.filePath.length - fileName.length - 1)
          );
          return (
            <div
              key={fc.filePath}
              className="border-b border-zinc-800 last:border-b-0"
            >
              <button
                onClick={() => toggleFile(fc.filePath)}
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
                      new
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
    </div>
  );
};
