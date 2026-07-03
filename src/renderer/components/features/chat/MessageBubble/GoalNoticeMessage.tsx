// ============================================================================
// GoalNoticeMessage - /goal 生命周期通知卡片
// ============================================================================
// 渲染 source='goal' 的消息：开启目标 / 目标已完成 / 目标已中止。
// content 由 goalNotice.ts 编码，这里解析后按 kind 出不同样式（参考 SkillStatusMessage）。
// ============================================================================

import React from 'react';
import { Target, CheckCircle2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../../../hooks/useI18n';
import { parseGoalNotice, type GoalNoticePayload } from '../goalNotice';

export interface GoalNoticeMessageProps {
  content: string;
}

/** 把 ms 格式化成 "Xm Ys" / "Ys" */
function formatDuration(ms?: number): string | null {
  if (ms == null || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** 完成/中止时的元信息行（耗时 · 轮次 · token） */
function MetaLine({ notice }: { notice: GoalNoticePayload }) {
  const { t } = useI18n();
  const parts: string[] = [];
  const dur = formatDuration(notice.durationMs);
  if (dur) parts.push(`${t.goalNotice.durationPrefix}${dur}`);
  if (notice.turns != null) parts.push(`${notice.turns}${t.goalNotice.turnsSuffix}`);
  if (notice.tokensUsed != null) parts.push(`${notice.tokensUsed.toLocaleString()} token`);
  if (parts.length === 0) return null;
  return <span className="text-[11px] text-zinc-500">{parts.join(' · ')}</span>;
}

function VerificationCardLine({ notice }: { notice: GoalNoticePayload }) {
  const card = notice.verificationCard;
  if (!card) return null;
  const parts = [
    `pass ${card.counts.passed}`,
    `fail ${card.counts.failed}`,
    `not_run ${card.counts.notRun}`,
    `required ${card.requiredStatus}`,
  ];
  const tone = card.status === 'passed'
    ? 'text-emerald-300/90'
    : card.status === 'failed'
      ? 'text-rose-300/90'
      : 'text-zinc-400';
  const refs = card.evidenceRefIds.length > 0
    ? `refs ${card.evidenceRefIds.slice(0, 3).join(', ')}${card.evidenceRefIds.length > 3 ? ` +${card.evidenceRefIds.length - 3}` : ''}`
    : null;
  return (
    <div className="mt-1 flex flex-col gap-0.5 pl-6 text-[11px]">
      <div className="flex items-center gap-1.5">
        <ShieldCheck className={`h-3.5 w-3.5 ${tone}`} />
        <span className={tone}>{parts.join(' · ')}</span>
      </div>
      <div className="text-zinc-500">{card.summary}</div>
      {refs && <div className="text-zinc-500">{refs}</div>}
    </div>
  );
}

/** 到限放行的安静降级标识：小字徽标，不抢完成卡的主视觉 */
function DegradedBadge({ notice }: { notice: GoalNoticePayload }) {
  const { t } = useI18n();
  if (!notice.degraded) return null;
  return (
    <div className="pl-6 flex flex-col gap-0.5">
      <span className="inline-flex w-fit items-center rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-300/80">
        {t.goalNotice.degradedBadge}
      </span>
      {notice.degradedReason && (
        <span className="text-[11px] text-zinc-500">
          {t.goalNotice.degradedReasonPrefix}{notice.degradedReason}
        </span>
      )}
    </div>
  );
}

export const GoalNoticeMessage: React.FC<GoalNoticeMessageProps> = ({ content }) => {
  const { t } = useI18n();
  const notice = parseGoalNotice(content);
  if (!notice) return null;

  if (notice.kind === 'start') {
    return (
      <div className="goal-notice my-1 flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
        <Target className="h-4 w-4 flex-shrink-0 text-sky-400" />
        <span className="text-zinc-300">
          {t.goalNotice.startPrefix}<span className="font-medium text-zinc-100">{notice.goal}</span>
        </span>
      </div>
    );
  }

  if (notice.kind === 'met') {
    return (
      <div className="goal-notice my-1 flex flex-col gap-0.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-400" />
          <span className="text-zinc-300">
            {t.goalNotice.metPrefix}<span className="font-medium text-zinc-100">{notice.goal}</span>
          </span>
        </div>
        <div className="pl-6">
          <MetaLine notice={notice} />
        </div>
        <DegradedBadge notice={notice} />
        <VerificationCardLine notice={notice} />
      </div>
    );
  }

  // aborted
  return (
    <div className="goal-notice my-1 flex flex-col gap-0.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" />
        <span className="text-zinc-300">
          {t.goalNotice.abortedPrefix}<span className="font-medium text-zinc-100">{notice.goal}</span>
        </span>
      </div>
      {notice.reason && <div className="pl-6 text-[11px] text-amber-300/80">{notice.reason}</div>}
      <div className="pl-6">
        <MetaLine notice={notice} />
      </div>
      <VerificationCardLine notice={notice} />
    </div>
  );
};
