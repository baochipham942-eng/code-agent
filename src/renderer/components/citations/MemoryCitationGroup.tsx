// ============================================================================
// MemoryCitationGroup - Codex 风格的 memory 引用折叠卡片
// ============================================================================
// 把模型在工具结果里引用到的 memory 来源（MEMORY.md / soul.md / daily/ 等）
// 收成一个折叠组：来源文件 + 行号 + rationale（"为什么用这段"），让用户能跟着
// 模型的脑回路走。挂在 ToolDetails 里，仅当 toolResult.metadata.citations 包含
// memory 类型时显示。
//
// 设计参考：~/.claude/plans/dreamy-sniffing-lagoon.md (P0 内核 task 15)

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Citation } from '@shared/contract/citation';
import { isWebMode, isTauriMode, copyPathToClipboard } from '../../utils/platform';

interface Props {
  citations: Citation[];
  defaultExpanded?: boolean;
}

export function MemoryCitationGroup({ citations, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // 仅展示 memory 类型；其他类型走原有 CitationList chip 流程
  const memoryCitations = citations.filter((c) => c.type === 'memory');
  if (memoryCitations.length === 0) return null;

  return (
    <div className="mt-1.5 border border-zinc-700/60 rounded text-xs">
      <button
        type="button"
        className="flex items-center gap-1.5 px-2 py-1 w-full text-left hover:bg-zinc-800/40 text-zinc-400"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>
          {memoryCitations.length} memory citation{memoryCitations.length > 1 ? 's' : ''}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-2">
          {memoryCitations.map((c) => (
            <MemoryCitationRow key={c.id} citation={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryCitationRow({ citation }: { citation: Citation }) {
  const handleClick = async () => {
    if (isWebMode()) {
      await copyPathToClipboard(citation.source);
      return;
    }
    if (isTauriMode()) {
      try {
        const { openPath } = await import('@tauri-apps/plugin-opener');
        await openPath(citation.source);
      } catch (error) {
        console.error('[MemoryCitation] open failed:', error);
      }
    }
  };

  const lineLabel = citation.lineRange
    ? `lines ${citation.lineRange[0]}-${citation.lineRange[1]}`
    : citation.location ?? null;

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={handleClick}
          className="text-blue-400 hover:underline font-mono"
          title={citation.source}
        >
          {citation.label}
        </button>
        {lineLabel && (
          <span className="text-zinc-500 font-mono">{lineLabel}</span>
        )}
      </div>
      {citation.rationale && (
        <div className="text-zinc-400 italic mt-0.5">{citation.rationale}</div>
      )}
    </div>
  );
}
