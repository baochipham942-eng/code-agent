// ============================================================================
// InlineStrip - 输入框上方的上下文压缩反馈线
// ============================================================================

import React from 'react';
import { Loader2 } from 'lucide-react';
import { useContextCompactionStore } from '../../../stores/contextCompactionStore';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export const InlineStrip: React.FC = () => {
  const status = useContextCompactionStore((s) => s.status);
  const result = useContextCompactionStore((s) => s.result);
  const error = useContextCompactionStore((s) => s.error);

  if (status === 'idle') return null;

  const isActive = status === 'active';
  const isError = status === 'error';
  const label = isActive
    ? '正在压缩上下文'
    : isError
      ? error || '压缩失败'
      : result?.totalSavedTokens && result.totalSavedTokens > 0
        ? `已释放 ${formatTokens(result.totalSavedTokens)}`
        : `已压缩 ${result?.compressionCount ?? 1} 次`;

  return (
    <div className="relative mx-auto max-w-3xl px-4 py-1.5 animate-fade-in">
      <div className="h-px w-full bg-white/[0.08]" />
      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center pointer-events-none">
        <div className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs shadow-lg ${
          isError
            ? 'bg-red-500/10 text-red-300 ring-1 ring-red-500/20'
            : 'bg-zinc-800 text-zinc-300 ring-1 ring-white/[0.06]'
        }`}>
          {isActive && <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-400" />}
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
};
