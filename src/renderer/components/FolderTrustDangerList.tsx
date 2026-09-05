import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useI18n } from '../hooks/useI18n';

export interface FolderTrustDangerousItem {
  kind: string;
  displayPath: string;
  risk: string;
  gated: boolean;
  count?: number;
}

function riskText(risk: string, labels: Record<string, string>): string {
  return labels[risk] ?? risk;
}

/** 每项说清「会发生什么」。host 只给 kind/count，人话在 i18n 里（不出现 hook/MCP/Agent 这类工程词）。 */
function itemText(item: FolderTrustDangerousItem, texts: Record<string, string>): string {
  const template = texts[item.kind] ?? texts['other-project-config'];
  return template.replace('{count}', String(item.count ?? 1));
}

/** 目录危险项清单展示：FolderTrustDialog 与新建空间确认步共用同一份（禁复制两份） */
export const FolderTrustDangerList: React.FC<{ items: FolderTrustDangerousItem[] }> = ({ items }) => {
  const { t } = useI18n();
  const copy = t.folderTrust;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);
  const updateOverflowHint = useCallback(() => {
    const element = scrollRef.current;
    setHasMoreBelow(Boolean(element && element.scrollHeight - element.scrollTop > element.clientHeight + 1));
  }, []);

  useEffect(() => {
    updateOverflowHint();
    window.addEventListener('resize', updateOverflowHint);
    return () => window.removeEventListener('resize', updateOverflowHint);
  }, [items, updateOverflowHint]);

  return (
    <div className="space-y-2" data-testid="folder-trust-danger-list">
      <p className="text-zinc-400">{copy.detected}</p>
      <div className="relative">
        <div
          ref={scrollRef}
          className="scrollbar-band max-h-56 space-y-2 overflow-y-scroll pr-1"
          data-testid="folder-trust-danger-scroll"
          onScroll={updateOverflowHint}
        >
          {items.map((item) => (
            <div
              key={`${item.kind}:${item.displayPath}`}
              className="rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-zinc-100">{itemText(item, copy.items)}</p>
                  <p className="mt-1 font-mono text-xs text-zinc-500 break-all">{item.displayPath}</p>
                </div>
                <span className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
                  {riskText(item.risk, copy.risks)}
                </span>
              </div>
            </div>
          ))}
        </div>
        {hasMoreBelow && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-10 items-end justify-center bg-gradient-to-t from-[var(--bg-elevated)] to-transparent pb-1"
            data-testid="folder-trust-more-hint"
          >
            <span className="rounded-full border border-zinc-700 bg-[var(--bg-elevated)] p-0.5 text-zinc-500 shadow-sm">
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
