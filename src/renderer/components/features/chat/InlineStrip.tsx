// ============================================================================
// InlineStrip - 输入框上方极轻量的 context 状态条
// ============================================================================
// 替代 ContextIndicator，增加 Compact 按钮和结构化压缩反馈
// 数据来源：useStatusRailModel（统一数据层）

import React, { useState, useCallback } from 'react';
import { Shrink, Loader2 } from 'lucide-react';
import { useStatusRailModel } from '../../../hooks/useStatusRailModel';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CompactResult } from '@shared/types/contextHealth';
import ipcService from '../../../services/ipcService';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

export const InlineStrip: React.FC = () => {
  const { context, compact } = useStatusRailModel();
  const [isCompacting, setIsCompacting] = useState(false);
  const [feedback, setFeedback] = useState<CompactResult | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  if (context.usagePercent < 50) return null;

  const barColor =
    context.warningLevel === 'critical' ? 'bg-red-500' :
    context.warningLevel === 'warning' ? 'bg-yellow-500' :
    'bg-emerald-500';

  const textColor =
    context.warningLevel === 'critical' ? 'text-red-400' :
    context.warningLevel === 'warning' ? 'text-yellow-400' :
    'text-zinc-500';

  const handleCompact = useCallback(async () => {
    if (isCompacting || !compact.canCompact) return;
    setIsCompacting(true);
    setFeedback(null);
    setFeedbackError(null);
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_FROM, '') as CompactResult;
      if (result.success) {
        setFeedback(result);
      } else {
        setFeedbackError('压缩失败');
      }
      setTimeout(() => { setFeedback(null); setFeedbackError(null); }, 4000);
    } catch {
      setFeedbackError('压缩失败');
      setTimeout(() => setFeedbackError(null), 3000);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, compact.canCompact]);

  return (
    <div className="flex items-center gap-2 px-4 py-1 max-w-3xl mx-auto animate-fade-in">
      {/* 进度条 */}
      <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500`}
          style={{ width: `${Math.min(100, context.usagePercent)}%` }}
        />
      </div>

      {/* 百分比 */}
      <span className={`text-[10px] tabular-nums ${textColor} flex-shrink-0`}>
        {Math.round(context.usagePercent)}%
      </span>

      {/* 压缩结果反馈 */}
      {feedback && (
        <span className="text-[10px] text-emerald-400 flex-shrink-0 animate-fade-in">
          {feedback.totalSavedTokens > 0
            ? `累计释放 ${formatTokens(feedback.totalSavedTokens)}`
            : `已压缩 ${feedback.compressionCount} 次`
          }
        </span>
      )}

      {/* 错误反馈 */}
      {feedbackError && (
        <span className="text-[10px] text-red-400 flex-shrink-0 animate-fade-in">
          {feedbackError}
        </span>
      )}

      {/* 高压提示 */}
      {context.warningLevel === 'critical' && !feedback && !feedbackError && (
        <span className="text-[10px] text-red-400 flex-shrink-0">
          上下文紧张
        </span>
      )}

      {/* Compact 按钮 */}
      {compact.canCompact && (
        <button
          onClick={handleCompact}
          disabled={isCompacting}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors disabled:opacity-50"
          title="主动压缩上下文"
        >
          {isCompacting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Shrink className="w-3 h-3" />
          )}
          <span>Compact</span>
        </button>
      )}
    </div>
  );
};
