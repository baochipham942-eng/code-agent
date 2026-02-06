// ============================================================================
// DiffPanel - 会话级变更追踪面板
// ============================================================================
// 展示当前会话中所有文件变更的 unified diff

import React, { useEffect, useState, useCallback } from 'react';
import { DiffView } from '../DiffView';
import { IPC_DOMAINS } from '@shared/ipc';
import type { FileDiff, DiffSummary } from '@shared/types/diff';

interface DiffPanelProps {
  sessionId: string;
  className?: string;
}

export function DiffPanel({ sessionId, className = '' }: DiffPanelProps) {
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [summary, setSummary] = useState<DiffSummary | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDiffs = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const res = await window.domainAPI?.invoke<FileDiff[]>(
        IPC_DOMAINS.DIFF,
        'getSessionDiffs',
        { sessionId }
      );
      if (res?.success && res.data) {
        setDiffs(res.data);
      }
      const sumRes = await window.domainAPI?.invoke<DiffSummary>(
        IPC_DOMAINS.DIFF,
        'getSummary',
        { sessionId }
      );
      if (sumRes?.success && sumRes.data) {
        setSummary(sumRes.data);
      }
    } catch {
      // 静默处理
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    loadDiffs();
  }, [loadDiffs]);

  if (loading) {
    return (
      <div className={`p-4 text-gray-500 text-sm ${className}`}>
        加载变更记录...
      </div>
    );
  }

  if (diffs.length === 0) {
    return (
      <div className={`p-4 text-gray-500 text-sm ${className}`}>
        本会话暂无文件变更
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* 摘要栏 */}
      {summary && (
        <div className="flex items-center gap-4 px-3 py-2 bg-zinc-800/50 rounded-lg text-xs font-mono">
          <span className="text-gray-400">
            {summary.filesChanged} 个文件
          </span>
          <span className="text-emerald-400">+{summary.totalAdditions}</span>
          <span className="text-rose-400">-{summary.totalDeletions}</span>
        </div>
      )}

      {/* Diff 列表 */}
      <div className="flex flex-col gap-1">
        {diffs.map((diff) => (
          <DiffEntry
            key={diff.id}
            diff={diff}
            expanded={expandedId === diff.id}
            onToggle={() =>
              setExpandedId(expandedId === diff.id ? null : diff.id)
            }
          />
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// DiffEntry - 单个 diff 条目
// ----------------------------------------------------------------------------

interface DiffEntryProps {
  diff: FileDiff;
  expanded: boolean;
  onToggle: () => void;
}

function DiffEntry({ diff, expanded, onToggle }: DiffEntryProps) {
  const fileName = diff.filePath.split('/').pop() || diff.filePath;
  const dirPath = diff.filePath.substring(
    0,
    diff.filePath.length - fileName.length
  );

  return (
    <div className="rounded-lg overflow-hidden border border-zinc-700/50">
      {/* 文件头 */}
      <button
        onClick={onToggle}
        className="
          w-full flex items-center gap-2 px-3 py-2
          bg-zinc-800/80 hover:bg-zinc-800
          text-left text-xs font-mono
          transition-colors
        "
      >
        <span className="text-gray-500 select-none">
          {expanded ? '▼' : '▶'}
        </span>
        <span className="text-gray-500 truncate">{dirPath}</span>
        <span className="text-blue-400">{fileName}</span>
        <span className="flex-1" />
        <span className="text-emerald-400">+{diff.stats.additions}</span>
        <span className="text-rose-400">-{diff.stats.deletions}</span>
      </button>

      {/* 展开的 diff 内容 */}
      {expanded && diff.before !== null && diff.after !== null && (
        <DiffView
          oldText={diff.before}
          newText={diff.after}
          className="border-t border-zinc-700/50"
        />
      )}
      {expanded && (diff.before === null || diff.after === null) && (
        <pre className="p-3 text-xs font-mono text-gray-400 bg-zinc-900 overflow-x-auto max-h-64">
          {diff.unifiedDiff}
        </pre>
      )}
    </div>
  );
}
