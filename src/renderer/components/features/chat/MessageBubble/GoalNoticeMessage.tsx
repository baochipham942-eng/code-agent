// ============================================================================
// GoalNoticeMessage - /goal 生命周期通知卡片
// ============================================================================
// 渲染 source='goal' 的消息：开启目标 / 目标已完成 / 目标已中止。
// content 由 goalNotice.ts 编码，这里解析后按 kind 出不同样式（参考 SkillStatusMessage）。
// ============================================================================

import React from 'react';
import { Target, CheckCircle2, AlertTriangle } from 'lucide-react';
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
  const parts: string[] = [];
  const dur = formatDuration(notice.durationMs);
  if (dur) parts.push(`耗时 ${dur}`);
  if (notice.turns != null) parts.push(`${notice.turns} 轮`);
  if (notice.tokensUsed != null) parts.push(`${notice.tokensUsed.toLocaleString()} token`);
  if (parts.length === 0) return null;
  return <span className="text-[11px] text-zinc-500">{parts.join(' · ')}</span>;
}

export const GoalNoticeMessage: React.FC<GoalNoticeMessageProps> = ({ content }) => {
  const notice = parseGoalNotice(content);
  if (!notice) return null;

  if (notice.kind === 'start') {
    return (
      <div className="goal-notice my-1 flex items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
        <Target className="h-4 w-4 flex-shrink-0 text-sky-400" />
        <span className="text-zinc-300">
          开启目标：<span className="font-medium text-zinc-100">{notice.goal}</span>
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
            目标已完成：<span className="font-medium text-zinc-100">{notice.goal}</span>
          </span>
        </div>
        <div className="pl-6">
          <MetaLine notice={notice} />
        </div>
      </div>
    );
  }

  // aborted
  return (
    <div className="goal-notice my-1 flex flex-col gap-0.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-400" />
        <span className="text-zinc-300">
          目标已中止：<span className="font-medium text-zinc-100">{notice.goal}</span>
        </span>
      </div>
      {notice.reason && <div className="pl-6 text-[11px] text-amber-300/80">{notice.reason}</div>}
      <div className="pl-6">
        <MetaLine notice={notice} />
      </div>
    </div>
  );
};
