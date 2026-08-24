import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';

export interface ReceiptRowItem {
  id: string;
  status: 'succeeded' | 'failed';
  summary: string;
  detail?: string;
  sourceTool: string;
  createdAt: number;
}

export function ReceiptRows({ items }: { items: ReceiptRowItem[] }) {
  const { language, t } = useI18n();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const copy = t.receiptPresentation;

  const toggle = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-1" data-testid="receipt-rows">
      {items.map((item) => {
        const failed = item.status === 'failed';
        const expanded = expandedIds.has(item.id);
        const canExpand = Boolean(item.detail);
        const time = new Date(item.createdAt).toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        return (
          <div key={item.id} data-testid="receipt-row">
            <button /* ds-allow:button: 回执行本身即展开热区，须与「来源」「过程材料」的同款行保持一致，不走带 variant 内边距的 Button primitive */
              type="button"
              disabled={!canExpand}
              aria-expanded={canExpand ? expanded : undefined}
              aria-label={canExpand ? (expanded ? copy.hideDetails : copy.showDetails) : undefined}
              onClick={() => canExpand && toggle(item.id)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.03] disabled:cursor-default"
            >
              {canExpand && (expanded
                ? <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />)}
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                failed
                  ? 'bg-red-500/10 text-badge-danger'
                  : 'bg-emerald-500/10 text-badge-success'
              }`}>
                {failed ? copy.failed : copy.succeeded}
              </span>
              <span className={`min-w-0 flex-1 truncate text-xs ${failed ? 'text-badge-danger' : 'text-zinc-200'}`} title={item.summary}>
                {item.summary}
              </span>
              <span className="max-w-[110px] shrink-0 truncate text-[10px] text-zinc-600">{item.sourceTool}</span>
              <time className="shrink-0 text-[10px] tabular-nums text-zinc-600">{time}</time>
            </button>
            {expanded && item.detail && (
              <pre className={`mx-1.5 mb-1 whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 text-[11px] leading-relaxed ${
                failed
                  ? 'border-red-500/20 bg-red-500/[0.05] text-badge-danger/80'
                  : 'border-white/[0.06] bg-black/15 text-zinc-400'
              }`}>
                {item.detail}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
