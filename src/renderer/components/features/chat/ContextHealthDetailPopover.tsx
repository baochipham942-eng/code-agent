// ============================================================================
// ContextHealthDetailPopover - 上下文健康明细弹层
// 长在输入框上方（锚在圆环上、bottom-full 展开，Cursor 同款不割裂形态）。
// 两个打开入口：点击 ContextUsagePill 圆环、context 深链（OPEN_CONTEXT_HEALTH_EVENT）。
//
// 桶清单口径（2026-08-21 爸拍板定稿，设计稿见私档
// docs/competitive/2026-08-21-cursor-vs-neo-context-panel.html）：
// - 九桶一张平铺清单（结构维度的系统提示/工具定义与来源维度同表），0 值不占位
// - 顺序 = 上下文组装序（固定开销在前 → 挂载能力 → 动态读入 → 摘要 → 对话），
//   每轮占比变化时行序稳定可扫读，且与 prefix cache 命中方向同构
// - 聚合类目走界面语言（技能/连接器/子代理），不列具体挂载名，桶行无跳转/卸载
// - 配色：摘要独立 rose（压缩是动作产物）；系统提示浅灰；对话深灰；
//   规则 teal；挂载能力鲜色（技能 indigo / 连接器 amber / 子代理 cyan）
// ============================================================================

import React, { useEffect } from 'react';
import { Loader2, Shrink, X as XIcon } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { useAppStore } from '../../../stores/appStore';
import { useStatusStore } from '../../../stores/statusStore';
import { useContextCompactionStore } from '../../../stores/contextCompactionStore';
import { useBudgetStatus } from '../../../hooks/useBudgetStatus';
import { CostDisplay } from '../../StatusBar/CostDisplay';
import { useContextHealthActions } from '../../../hooks/useContextHealthActions';
import { formatContextUsagePercent } from '../../../utils/contextUsageFormat';
import type { ContextHealthState } from '@shared/contract/contextHealth';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

interface BucketSpec {
  key: string;
  name: string;
  tokens: number;
  color: string;
}

/**
 * 九桶清单（组装序）。颜色用显式 hex：弹层是固定深色面（bg-zinc-900/95），
 * 不随主题翻转，不走 surface token（surfaceTokenConvergence 白名单已登记）。
 */
function buildBuckets(health: ContextHealthState, ch: Record<string, string>): BucketSpec[] {
  const bs = health.breakdown.bySource;
  const sumRecord = (rec?: Record<string, number>) =>
    Object.values(rec ?? {}).reduce((a, b) => a + b, 0);
  const compressionCount = health.compression?.compressionCount ?? 0;
  return [
    { key: 'systemPrompt', name: ch.bkSystemPrompt, tokens: health.breakdown.systemPrompt, color: '#a8a8b0' },
    { key: 'toolDefs', name: ch.bkToolDefs, tokens: health.breakdown.toolDefinitions ?? 0, color: '#60a5fa' },
    { key: 'rules', name: ch.bkRules, tokens: bs?.rules ?? 0, color: '#2dd4bf' },
    { key: 'skills', name: ch.bkSkills, tokens: sumRecord(bs?.skills), color: '#818cf8' },
    { key: 'mcp', name: ch.bkMcp, tokens: sumRecord(bs?.mcp), color: '#f59e0b' },
    { key: 'subagents', name: ch.bkSubagents, tokens: sumRecord(bs?.subagents), color: '#22d3ee' },
    { key: 'fileReads', name: ch.bkFileReads, tokens: bs?.fileReads ?? 0, color: '#10b981' },
    {
      key: 'summary',
      name: ch.bkSummary.replace('{count}', String(compressionCount)),
      tokens: bs?.summary ?? 0,
      color: '#fb7185',
    },
    { key: 'conversation', name: ch.bkConversation, tokens: bs?.conversation ?? 0, color: '#52525b' },
  ].filter((bucket) => bucket.tokens > 0);
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
  const { handleCompact, isCompacting } = useContextHealthActions();
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

  const buckets = contextHealth ? buildBuckets(contextHealth, ch) : [];
  const total = contextHealth?.currentTokens ?? 0;

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
            {/* 大数字行 + 分段总条：总量的唯一出口 */}
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

            {buckets.length > 0 && total > 0 && (
              <>
                <div
                  className="mb-3 flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800"
                  data-testid="context-source-bar"
                >
                  {buckets.map((bucket) => (
                    <div
                      key={bucket.key}
                      className="h-full"
                      style={{ width: `${(bucket.tokens / total) * 100}%`, background: bucket.color }}
                      title={ch.sourceBucketTitle
                        .replace('{name}', bucket.name)
                        .replace('{tokens}', formatTokens(bucket.tokens))
                        .replace('{percent}', ((bucket.tokens / total) * 100).toFixed(1))}
                    />
                  ))}
                </div>

                {/* 平铺桶清单：颜色点 + 类目 + token + 占比（相对窗口总量） */}
                <div data-testid="context-bucket-list">
                  {buckets.map((bucket) => (
                    <div key={bucket.key} className="flex items-center gap-2 py-1 text-xs">
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-sm"
                        style={{ background: bucket.color }}
                      />
                      <span className="text-zinc-300">{bucket.name}</span>
                      <span className="ml-auto text-[11px] text-zinc-400 tabular-nums">
                        {formatTokens(bucket.tokens)} · {((bucket.tokens / total) * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

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
