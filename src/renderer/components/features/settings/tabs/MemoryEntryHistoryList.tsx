// ============================================================================
// MemoryEntryHistoryList — 记忆详情的变更历史 + 逐行撤回
// （N-MEM-JOURNAL-SOURCEJUMP-FU2）
// ============================================================================
// 历史行本体从 MemoryEntriesManager 拆出（该文件逼近 max-lines 上限）。
// 后台 actor（auto review / role wake / dream / eviction / import / unknown）
// 的 update/delete/evict 行给「撤回」：确认后把 before 快照整段写回记忆。
// 快照被截断 / 没有快照 / 恢复失败 → 按钮禁用并给一行原因，绝不假装恢复。
// 撤回本身走面板既有 memoryEntryUpdate 通道，journal 自动多一条 user_manual 行。
// ============================================================================

import React, { useState } from 'react';
import { History, Loader2, Undo2 } from 'lucide-react';
import type {
  MemoryChangeJournalRow,
  MemoryEntryStatus,
} from '@shared/contract/memory';
import { Button } from '../../../primitives';
import { ConfirmDialog } from '../../../composites/ConfirmDialog';
import { zh } from '../../../../i18n/zh';
import {
  isUndoableJournalRow,
  parseMemoryJournalSnapshot,
  snapshotPreview,
} from './memoryJournalSnapshot';

type MemorySettingsText = typeof zh.settings.memory;

interface RestorableSnapshot {
  title: string;
  content: string;
  status: MemoryEntryStatus;
}

export interface MemoryEntryHistoryListProps {
  /** null = 加载中 */
  rows: MemoryChangeJournalRow[] | null;
  failed: boolean;
  labels: MemorySettingsText;
  locale: string;
  /** 面板有任何写操作在途时禁用撤回 */
  busy: boolean;
  /** 恢复尝试失败过的行 id（按行禁用 + 原因，不许重试到假装成功） */
  restoreFailedRowIds: ReadonlySet<number>;
  onRestore: (row: MemoryChangeJournalRow, snapshot: RestorableSnapshot) => Promise<boolean>;
}

export const MemoryEntryHistoryList: React.FC<MemoryEntryHistoryListProps> = ({
  rows,
  failed,
  labels,
  locale,
  busy,
  restoreFailedRowIds,
  onRestore,
}) => {
  const [pending, setPending] = useState<{ row: MemoryChangeJournalRow; snapshot: RestorableSnapshot } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const historyText = labels.entries.history;
  const undoText = historyText.undo;

  const confirmRestore = async () => {
    if (!pending || restoring) return;
    setRestoring(true);
    try {
      const ok = await onRestore(pending.row, pending.snapshot);
      if (ok) setPending(null);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-3 text-xs text-zinc-500" data-testid="memory-entry-history">
      <div className="mb-2 flex items-center gap-1.5 font-medium text-zinc-400">
        <History className="h-3.5 w-3.5" />
        {historyText.title}
      </div>
      {failed ? (
        <div className="text-badge-warning">{historyText.failed}</div>
      ) : rows === null ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : rows.length === 0 ? (
        <div>{historyText.empty}</div>
      ) : (
        <ol className="space-y-1.5">
          {rows.map((row) => {
            const snapshot = parseMemoryJournalSnapshot(row.beforeContent);
            const undoable = isUndoableJournalRow(row);
            const restoreFailed = undoable && restoreFailedRowIds.has(row.id);
            // 禁用原因只描述「这行为什么撤不了」；busy/restoring 是临时态，不解释
            const disabledReason = !undoable
              ? null
              : restoreFailed
                ? undoText.unresolvableReason
                : snapshot === null
                  ? undoText.noSnapshotReason
                  : snapshot.restorable
                    ? null
                    : undoText.truncatedReason;
            return (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2" data-testid="memory-entry-history-row">
                <span className="text-zinc-600">{new Date(row.timestamp).toLocaleString(locale)}</span>
                <span className="text-zinc-400">{historyText.operationLabels[row.operation] ?? row.operation}</span>
                <span className={row.actor === 'user_manual' ? 'text-zinc-500' : 'text-badge-info'}>
                  {historyText.actorLabels[row.actor] ?? row.actor}
                </span>
                {row.sessionId && (
                  <span className="truncate font-mono text-[10px] text-zinc-600">{row.sessionId.slice(0, 12)}</span>
                )}
                {undoable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto self-center px-2 py-0.5 text-[11px]"
                    disabled={busy || restoring || restoreFailed || !snapshot?.restorable}
                    onClick={() => {
                      if (snapshot?.restorable) setPending({ row, snapshot });
                    }}
                    leftIcon={<Undo2 className="h-3 w-3" />}
                    data-testid="memory-entry-history-undo"
                  >
                    {undoText.button}
                  </Button>
                )}
                {disabledReason && (
                  <span
                    className="basis-full pl-0.5 text-[11px] text-zinc-500"
                    data-testid="memory-entry-history-undo-reason"
                  >
                    {disabledReason}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <ConfirmDialog
        isOpen={pending !== null}
        title={undoText.confirmTitle}
        variant="warning"
        confirmText={undoText.button}
        cancelText={labels.entries.cancel}
        confirmDisabled={restoring}
        cancelDisabled={restoring}
        onConfirm={confirmRestore}
        onCancel={() => { if (!restoring) setPending(null); }}
        message={pending ? (
          <div className="space-y-2 text-sm text-zinc-400">
            <p className="leading-relaxed">{undoText.confirmBody}</p>
            <div className="text-xs text-zinc-500">{undoText.previewLabel}</div>
            <div
              className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-zinc-700 bg-zinc-950/60 p-2 font-mono text-xs text-zinc-300"
              data-testid="memory-entry-undo-preview"
            >
              {snapshotPreview(pending.snapshot.content)}
            </div>
          </div>
        ) : undefined}
      />
    </div>
  );
};
