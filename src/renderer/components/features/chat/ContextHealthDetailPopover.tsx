// ============================================================================
// ContextHealthDetailPopover - 上下文健康明细弹层
// 长在输入框上方（锚在圆环上、bottom-full 展开，Cursor 同款不割裂形态），
// 复用现成的 ContextHealthPanel（不新造面板组件），handlers 走共享
// useContextHealthActions。两个打开入口：点击 ContextUsagePill 圆环、
// context 深链（OPEN_CONTEXT_HEALTH_EVENT）。分桶条 / 累计费用 / 压缩钮
// 都收在本弹层，点击圆环一步到位。
// ============================================================================

import React, { useEffect } from 'react';
import { Loader2, Shrink, X as XIcon } from 'lucide-react';
import { ContextHealthPanel } from '../../ContextHealthPanel';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useStatusStore } from '../../../stores/statusStore';
import { useContextCompactionStore } from '../../../stores/contextCompactionStore';
import { useBudgetStatus } from '../../../hooks/useBudgetStatus';
import { CostDisplay } from '../../StatusBar/CostDisplay';
import { useContextHealthActions } from '../../../hooks/useContextHealthActions';
import { formatContextUsagePercent } from '../../../utils/contextUsageFormat';
import type { SourceBreakdown } from '@shared/contract/contextHealth';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

// 分桶条段：颜色用显式 zinc/accent 色（深浅主题下都可读，不走主题变量）
interface SourceSegment {
  key: string;
  name: string;
  tokens: number;
  barClass: string;
}

function buildSourceSegments(
  bySource: SourceBreakdown,
  ch: Record<string, string>,
  compressionCount: number,
): SourceSegment[] {
  const sumRecord = (rec: Record<string, number>) =>
    Object.values(rec).reduce((a, b) => a + b, 0);
  return [
    { key: 'rules', name: ch.bkRules, tokens: bySource.rules, barClass: 'bg-zinc-500' },
    { key: 'skills', name: 'Skills', tokens: sumRecord(bySource.skills), barClass: 'bg-indigo-500' },
    { key: 'mcp', name: 'MCP', tokens: sumRecord(bySource.mcp), barClass: 'bg-amber-500' },
    { key: 'subagents', name: 'Subagents', tokens: sumRecord(bySource.subagents), barClass: 'bg-cyan-500' },
    { key: 'fileReads', name: ch.bkFileReads, tokens: bySource.fileReads, barClass: 'bg-emerald-600' },
    {
      key: 'summary',
      name: ch.bkSummary.replace('{count}', String(compressionCount)),
      tokens: bySource.summary ?? 0,
      barClass: 'bg-violet-500',
    },
    { key: 'conversation', name: ch.bkConversation, tokens: bySource.conversation, barClass: 'bg-zinc-400' },
  ].filter((seg) => seg.tokens > 0);
}

interface ContextHealthDetailPopoverProps {
  onClose: () => void;
}

export const ContextHealthDetailPopover: React.FC<ContextHealthDetailPopoverProps> = ({
  onClose,
}) => {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const contextHealth = useAppStore((s) => s.contextHealth);
  const { handleNavigate, handleUnload, handleCompact, isCompacting } = useContextHealthActions();
  // 累计费用接线沿用 CostDisplay 预算感知口径（cache-aware 成本 + 缓存节省 tooltip
  // + 告警染色），useBudgetStatus 非轮询。从原圆环弹层搬来，口径未变。
  const sessionCost = useStatusStore((s) => s.sessionCost);
  const unknownCostTurns = useStatusStore((s) => s.unknownCostTurns);
  const isStreaming = useStatusStore((s) => s.isStreaming);
  const budgetStatus = useBudgetStatus(sessionCost, isStreaming);
  const compactResult = useContextCompactionStore((s) => s.result);
  const compactError = useContextCompactionStore((s) => s.error);
  const clearCompaction = useContextCompactionStore((s) => s.clear);

  // 卸载时清掉压缩反馈，下次打开不残留上一轮的结果
  useEffect(() => () => clearCompaction(), [clearCompaction]);

  const usagePercent = contextHealth?.usagePercent ?? 0;
  const canCompact = usagePercent >= 70;
  // 操作区（费用 / 压缩反馈 / 压缩钮）按需整体渲染，避免全空时只剩一条分隔线
  const hasCost = sessionCost > 0 || unknownCostTurns > 0;
  const showActionRow = hasCost || canCompact || !!compactResult || !!compactError;

  // 分桶条：bySource 为空/全 0 时不渲染
  const bySource = contextHealth?.breakdown?.bySource;
  const sourceSegments = bySource
    ? buildSourceSegments(bySource, ch, contextHealth?.compression?.compressionCount ?? 0)
    : [];
  const sourceTotal = sourceSegments.reduce((a, seg) => a + seg.tokens, 0);

  return (
    <div
      className="absolute bottom-full right-0 z-30 mb-2 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border border-border-hover bg-zinc-900/95 shadow-2xl backdrop-blur"
      data-testid="context-health-detail"
      role="dialog"
      aria-label={ch.detailModalTitle}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-xs font-medium text-zinc-300">{ch.detailModalTitle}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t.systemError.hideDetails}
          className="inline-flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-300"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-4 pb-3">
        {contextHealth ? (
          <div>
            {/* 大数字行：弹层里唯一讲「总量」的地方（面板自身的进度条和折叠头已让位） */}
            <div className="mb-2 flex items-baseline justify-between tabular-nums">
              <span className="text-sm font-semibold text-zinc-50">
                {ch.usageSummary
                  .replace('{percent}', formatContextUsagePercent(Math.max(0, Math.min(100, usagePercent))))
                  .replace('{remaining}', formatContextUsagePercent(Math.max(0, 100 - Math.max(0, Math.min(100, usagePercent)))))}
              </span>
              <span className="text-[11px] text-zinc-400">
                {ch.tokensFraction
                  .replace('{used}', formatTokens(contextHealth.currentTokens))
                  .replace('{max}', formatTokens(contextHealth.maxTokens))}
              </span>
            </div>
            {sourceSegments.length > 0 && sourceTotal > 0 && (
              <div
                className="mb-3 flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
                data-testid="context-source-bar"
              >
                {sourceSegments.map((seg) => (
                  <div
                    key={seg.key}
                    className={`h-full ${seg.barClass}`}
                    style={{ width: `${(seg.tokens / sourceTotal) * 100}%` }}
                    title={ch.sourceBucketTitle
                      .replace('{name}', seg.name)
                      .replace('{tokens}', formatTokens(seg.tokens))
                      .replace('{percent}', ((seg.tokens / sourceTotal) * 100).toFixed(1))}
                  />
                ))}
              </div>
            )}

            <ContextHealthPanel
              health={contextHealth}
              collapsed={false}
              onNavigate={handleNavigate}
              onUnload={handleUnload}
              isCompacting={isCompacting}
              hideHeader
              hideProgressBar
            />

            {showActionRow && (
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-border-muted pt-3">
                <div className="min-w-0 text-[11px] text-zinc-400 tabular-nums">
                  {hasCost && (
                    <CostDisplay cost={sessionCost} isStreaming={isStreaming} budget={budgetStatus} />
                  )}
                  {compactResult && (
                    <div className="mt-1 text-badge-success">
                      {compactResult.totalSavedTokens > 0
                        ? ch.freedTokens.replace('{tokens}', formatTokens(compactResult.totalSavedTokens))
                        : ch.compactedCount.replace('{count}', String(compactResult.compressionCount))}
                    </div>
                  )}
                  {compactError && (
                    <div className="mt-1 text-badge-danger">{compactError}</div>
                  )}
                </div>
                {canCompact && (
                  <button
                    type="button"
                    onClick={handleCompact}
                    disabled={isCompacting}
                    className="inline-flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-muted bg-surface-hover px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-70"
                    title={ch.compactButtonTitle}
                  >
                    {isCompacting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Shrink className="h-3.5 w-3.5" />
                    )}
                    <span>{isCompacting ? ch.compacting : ch.compactNow}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="py-6 text-sm text-zinc-500">
            <p>{ch.emptyStateTitle}</p>
            <p className="mt-2 text-xs text-zinc-600">
              {ch.emptyStateHint}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
