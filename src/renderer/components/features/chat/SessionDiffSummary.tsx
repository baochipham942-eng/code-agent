// ============================================================================
// SessionDiffSummary - 会话级 Diff 聚合卡，扫描所有 message.toolCalls 累加
// 文件改动，挂在 ChatInput 上方，对照 Codex 顶部 "X files changed" 卡片
// ============================================================================

import React, { useState, useMemo } from 'react';
import * as Diff from 'diff';
import { ChevronDown, ChevronRight, GitCommit } from 'lucide-react';
import type { Message } from '@shared/contract/message';

const FILE_WRITE_TOOLS = ['Edit', 'Write', 'edit_file', 'write_file'];

interface FileChange {
  filePath: string;
  added: number;
  removed: number;
  isNewFile: boolean;
  editCount: number;
}

interface SessionDiffSummaryProps {
  messages: Message[];
}

export const SessionDiffSummary: React.FC<SessionDiffSummaryProps> = ({ messages }) => {
  const [expanded, setExpanded] = useState(false);

  const fileChanges = useMemo<FileChange[]>(() => {
    const byPath = new Map<string, FileChange>();

    for (const msg of messages) {
      if (!msg.toolCalls?.length) continue;
      for (const tc of msg.toolCalls) {
        if (!FILE_WRITE_TOOLS.includes(tc.name)) continue;
        const result = tc.result;
        if (result && result.success === false) continue;

        const args = (tc.arguments || {}) as Record<string, unknown>;
        let filePath = (args.file_path ?? args.path) as string | undefined;

        const resultText = typeof result?.output === 'string' ? result.output : '';
        if (!filePath && resultText) {
          const m = resultText.match(/(?:Created|Updated) file:\s*(.+?)(?:\s+\(|\s*\n|$)/);
          if (m) filePath = m[1].trim();
        }
        if (!filePath && typeof result?.outputPath === 'string') {
          filePath = result.outputPath;
        }
        if (!filePath) continue;

        let oldText = '';
        let newText = '';
        let isNewFile = false;

        if (tc.name === 'Edit' || tc.name === 'edit_file') {
          oldText = (args.old_string as string) ?? '';
          newText = (args.new_string as string) ?? '';
        } else {
          newText = (args.content as string) ?? '';
          isNewFile = true;
          if (resultText && /^Updated file/m.test(resultText)) {
            isNewFile = false;
          }
        }

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
          existing.editCount += 1;
        } else {
          byPath.set(filePath, {
            filePath,
            added,
            removed,
            isNewFile,
            editCount: 1,
          });
        }
      }
    }

    return Array.from(byPath.values()).sort((a, b) =>
      b.added + b.removed - (a.added + a.removed)
    );
  }, [messages]);

  if (fileChanges.length === 0) return null;

  const totalAdded = fileChanges.reduce((s, f) => s + f.added, 0);
  const totalRemoved = fileChanges.reduce((s, f) => s + f.removed, 0);

  return (
    <div className="px-4 shrink-0">
      <div className="mb-2 max-w-3xl mx-auto">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] backdrop-blur-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors text-left"
            aria-expanded={expanded}
            title={expanded ? '折叠文件列表' : '查看本会话所有改动'}
          >
            <GitCommit className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
            <span className="text-sm text-zinc-300 font-medium flex-shrink-0">
              {fileChanges.length} file{fileChanges.length > 1 ? 's' : ''} changed
            </span>
            {totalAdded > 0 && (
              <span className="text-xs text-emerald-400">+{totalAdded}</span>
            )}
            {totalRemoved > 0 && (
              <span className="text-xs text-rose-400">-{totalRemoved}</span>
            )}
            <div className="flex-1" />
            <span className="text-xs text-zinc-500 flex items-center gap-1">
              {expanded ? 'Hide' : 'Review changes'}
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </span>
          </button>
          {expanded && (
            <ul className="px-3 pb-2 pt-1 space-y-0.5 max-h-[200px] overflow-y-auto border-t border-white/[0.06]">
              {fileChanges.map((fc) => {
                const fileName = fc.filePath.split('/').pop() || fc.filePath;
                const dirPath = fc.filePath.slice(
                  0,
                  Math.max(0, fc.filePath.length - fileName.length - 1)
                );
                return (
                  <li
                    key={fc.filePath}
                    className="flex items-center gap-2 py-1 text-xs"
                    title={fc.filePath}
                  >
                    <span className="font-mono truncate flex-1 min-w-0">
                      {dirPath && <span className="text-zinc-600">{dirPath}/</span>}
                      <span className="text-zinc-300">{fileName}</span>
                      {fc.isNewFile && (
                        <span className="ml-2 text-[10px] text-emerald-400/80">new</span>
                      )}
                      {fc.editCount > 1 && (
                        <span className="ml-2 text-[10px] text-zinc-500">
                          ×{fc.editCount}
                        </span>
                      )}
                    </span>
                    {fc.added > 0 && (
                      <span className="text-emerald-400 flex-shrink-0">+{fc.added}</span>
                    )}
                    {fc.removed > 0 && (
                      <span className="text-rose-400 flex-shrink-0">-{fc.removed}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
