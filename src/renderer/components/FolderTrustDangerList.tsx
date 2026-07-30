import React from 'react';
import { useI18n } from '../hooks/useI18n';

export interface FolderTrustDangerousItem {
  kind: string;
  displayPath: string;
  label: string;
  risk: string;
  gated: boolean;
}

function riskText(risk: string, labels: Record<string, string>): string {
  return labels[risk] ?? risk;
}

/** 目录危险项清单展示：FolderTrustDialog 与新建空间确认步共用同一份（禁复制两份） */
export const FolderTrustDangerList: React.FC<{ items: FolderTrustDangerousItem[] }> = ({ items }) => {
  const { t } = useI18n();
  const copy = t.folderTrust;
  return (
    <div className="space-y-2" data-testid="folder-trust-danger-list">
      <p className="text-zinc-400">{copy.detected}</p>
      <div className="max-h-56 space-y-2 overflow-auto pr-1">
        {items.map((item) => (
          <div
            key={`${item.kind}:${item.displayPath}`}
            className="rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-zinc-100">{item.label}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500 break-all">{item.displayPath}</p>
              </div>
              <span className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300">
                {riskText(item.risk, copy.risks)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
