// ============================================================================
// SessionInspector 层1 轮行（N-LEDGER-UX1：A 汇总句可展开 / B 异常黄条 / C 活行）
// ----------------------------------------------------------------------------
// 层1 面向非程序员协作者：
//   A · ≥2 次工具调用的轮，汇总句下可点开逐条明细（明细与账本 tool_dispatch 逐条对应）；
//       单工具轮不聚合、不出明细入口（保持原样）。
//   B · 层1 不显示任何 token/缓存数字；仅当本轮消耗触发甲口径异常
//       （> 其余轮均值 ×3 且 > 20k，model.ts 判定）时出黄点+一句人话，点开进层2 看数字。
//   C · 未 settle 的当前轮渲染活行（呼吸点 + 「正在做…（第 M 步）」），settle 后
//       同位置转为常规轮行（key 不变，不重复行、不整段重渲染）。
// ============================================================================

import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  XCircle,
} from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { fill } from './format';
import type { TurnSegment } from './model';
import { TurnDevtools } from './turnDevtools';

// ── 印章 chip：verified / self_claimed 可区分但不刺眼；n_a 按终态说人话 ────

function StampChip({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const stamp = t.sessionInspector.stamp;
  if (segment.inProgress) {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="in_progress"
        className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-surface-faint px-1.5 py-0.5 text-[10px] text-zinc-400"
      >
        <CircleDot className="h-3 w-3" />
        {t.sessionInspector.turnInProgress}
      </span>
    );
  }
  if (!segment.stamp) return null;
  const { verdict, terminal } = segment.stamp;
  if (verdict === 'verified') {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="verified"
        className="inline-flex items-center gap-1 rounded-md border border-badge-success/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-badge-success"
      >
        <CheckCircle2 className="h-3 w-3" />
        {stamp.verified}
        {segment.stamp.evidenceCount > 0 && (
          <span className="opacity-70">
            · {fill(t.sessionInspector.evidenceCount, { count: String(segment.stamp.evidenceCount) })}
          </span>
        )}
      </span>
    );
  }
  if (verdict === 'self_claimed') {
    return (
      <span
        data-testid="inspector-stamp"
        data-verdict="self_claimed"
        className="inline-flex items-center gap-1 rounded-md border border-badge-warning/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-badge-warning"
      >
        <AlertTriangle className="h-3 w-3" />
        {stamp.selfClaimed}
      </span>
    );
  }
  // n_a：按终态说人话（失败/取消自带原因，不判真伪）
  const label = terminal === 'cancelled'
    ? stamp.cancelled
    : terminal === 'interrupted'
      ? stamp.interrupted
      : terminal === 'failed'
        ? stamp.failed
        : terminal === 'aborted'
          ? stamp.aborted
          : terminal === 'goal_met'
            ? stamp.goalMet
            : stamp.ended;
  const tone = terminal === 'failed' || terminal === 'aborted'
    ? 'border-badge-danger/30 bg-red-500/10 text-badge-danger'
    : 'border-white/[0.08] bg-surface-faint text-zinc-400';
  return (
    <span
      data-testid="inspector-stamp"
      data-verdict="n_a"
      data-terminal={terminal ?? 'unknown'}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${tone}`}
    >
      {(terminal === 'failed' || terminal === 'aborted') && <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ── 层1：一轮的人话摘要行（A 汇总句可展开明细 + B 异常黄条；不出 token 数字）─

function TurnActivitySummary({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const activity = t.sessionInspector.activity;
  const detail = t.sessionInspector.activityDetail;
  const [showDetail, setShowDetail] = useState(false);
  const parts: string[] = [];
  if (segment.toolCounts.read > 0) parts.push(fill(activity.read, { count: String(segment.toolCounts.read) }));
  if (segment.toolCounts.write > 0) parts.push(fill(activity.write, { count: String(segment.toolCounts.write) }));
  if (segment.toolCounts.command > 0) parts.push(fill(activity.command, { count: String(segment.toolCounts.command) }));
  if (segment.toolCounts.browser > 0) parts.push(fill(activity.browser, { count: String(segment.toolCounts.browser) }));
  if (segment.toolCounts.other > 0) parts.push(fill(activity.otherTool, { count: String(segment.toolCounts.other) }));
  // A：≥2 次工具调用才给明细入口；单工具轮不聚合、保持原样
  const hasDetail = segment.toolDispatches.length >= 2;
  return (
    <div className="mt-0.5 text-[11px] text-zinc-500">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span data-testid="inspector-turn-activity">
          {parts.length > 0 ? parts.join(' · ') : activity.none}
          {segment.failedToolCount > 0 && (
            <span className="text-badge-warning">{fill(activity.failed, { count: String(segment.failedToolCount) })}</span>
          )}
        </span>
        {hasDetail && (
          <button /* ds-allow:button: 明细展开钮是行内超小文本按钮（同轮行展开钮范式） */
            type="button"
            data-testid="inspector-activity-detail-toggle"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((value) => !value)}
            className="inline-flex items-center gap-0.5 text-zinc-600 transition-colors hover:text-zinc-400"
          >
            {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {showDetail ? detail.collapse : detail.expand}
          </button>
        )}
        {segment.tokenAnomaly && (
          <span data-testid="inspector-token-anomaly" className="inline-flex items-center gap-1 text-badge-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-mark-warning" />
            {t.sessionInspector.tokenAnomaly}
          </span>
        )}
      </div>
      {hasDetail && showDetail && (
        <div className="mt-0.5 space-y-0.5 pl-3" data-testid="inspector-activity-detail">
          {segment.toolDispatches.map((row, index) => (
            <div key={index} className="flex items-baseline gap-2" data-testid="inspector-activity-detail-row">
              <span className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${row.success ? 'bg-badge-success' : 'bg-badge-danger'}`} />
              <span className="shrink-0 text-zinc-500">{detail.bucketLabel[row.bucket]}</span>
              <span className="font-mono text-[10px] text-zinc-400">{row.toolName}</span>
              {!row.success && <span className="text-badge-danger">{row.error ?? ''}</span>}
              {row.durationMs !== null && (
                <span className="ml-auto text-zinc-600">{Math.round(row.durationMs)} ms</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 层1 轮行（点开展开层2）───────────────────────────────────────────────

export function TurnRow({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="inspector-turn" className="px-0.5 py-1">
      <button /* ds-allow:button: 轮行展开钮是整行超小文本按钮，primitive 最小档仍过大 */
        type="button"
        data-testid="inspector-turn-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />}
        <span className="shrink-0 text-xs font-medium text-zinc-300">
          {fill(t.sessionInspector.turnLabel, { count: String(segment.index) })}
        </span>
        <StampChip segment={segment} />
        {segment.startedAt !== null && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
            {new Date(segment.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </button>
      <div className="pl-5">
        <TurnActivitySummary segment={segment} />
        {open && <TurnDevtools segment={segment} />}
      </div>
    </div>
  );
}

// ── C · 进行中活行：未 settle 的当前轮；settle 后同位置转常规 TurnRow ──────

export function LiveTurnRow({ segment }: { segment: TurnSegment }) {
  const { t } = useI18n();
  const live = t.sessionInspector.live;
  const bucketLabel = t.sessionInspector.activityDetail.bucketLabel;
  const stepCount = segment.toolDispatches.length;
  const doing = segment.lastToolBucket !== null && stepCount > 0
    ? fill(live.doing, { activity: bucketLabel[segment.lastToolBucket], step: String(stepCount) })
    : live.waiting;
  return (
    <div data-testid="inspector-live-turn" className="px-0.5 py-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-mark-warning" data-testid="inspector-live-dot" />
        <span className="shrink-0 text-xs font-medium text-zinc-300">
          {fill(t.sessionInspector.turnLabel, { count: String(segment.index) })}
        </span>
        <span className="text-[11px] text-zinc-500">
          {t.sessionInspector.turnInProgress} —— {doing}
        </span>
        {segment.startedAt !== null && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
            {new Date(segment.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}
