import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { parseModelFallbackNotice } from '../fallbackNotice';

export const FallbackBanner: React.FC<{ content: string }> = ({ content }) => {
  const notice = parseModelFallbackNotice(content);
  if (!notice) return null;

  return (
    <div className="my-1 flex min-w-0 items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="min-w-0">
        <div className="text-xs font-medium text-amber-200">模型已降级</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
          <span className="max-w-full truncate font-mono text-zinc-300">{notice.from}</span>
          <span className="text-zinc-600">-&gt;</span>
          <span className="max-w-full truncate font-mono text-zinc-300">{notice.to}</span>
          <span className="text-zinc-600">·</span>
          <span className="min-w-0 truncate text-amber-200/80">{notice.reason}</span>
        </div>
      </div>
    </div>
  );
};
