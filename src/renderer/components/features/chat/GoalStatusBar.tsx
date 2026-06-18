// ============================================================================
// GoalStatusBar - /goal 运行进度状态条
// ============================================================================
// 挂在 ChatInput 上方（独立一行，不与 Skill/MCP pill 混排）。
// goal 运行中（status='running'）时显示：目标 · 已运行时长(实时) · 第 N/M 轮 · token 用量。
// 完成/中止后由聊天区的 GoalNoticeMessage 卡片接管，状态条自动隐藏。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Target, Loader2 } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

export const GoalStatusBar: React.FC = () => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const run = useAppStore((s) => (currentSessionId ? s.goalRuns[currentSessionId] : undefined));

  // 实时计时器：仅运行中每秒刷新一次
  const [now, setNow] = useState(() => Date.now());
  const running = run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (run?.status !== 'running') return null;

  const elapsed = formatElapsed(now - run.startedAt);
  // 墙钟剩余（①）：仅当设了时间预算才显示，剩 0 时高亮提醒即将兜底中止
  const remainingMs =
    run.wallClockBudgetMs !== undefined ? run.wallClockBudgetMs - (now - run.startedAt) : undefined;
  const gateHint =
    run.lastGate?.gate === 1 ? '验证中…' : run.lastGate?.gate === 2 ? '评审中…' : null;

  return (
    <div className="goal-status-bar mx-auto mb-1 flex w-full max-w-3xl items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/[0.07] px-3 py-1.5 text-xs">
      <Target className="h-3.5 w-3.5 flex-shrink-0 text-sky-400" />
      <span className="truncate text-zinc-300" title={run.goal}>
        目标进行中：<span className="text-zinc-100">{run.goal}</span>
      </span>
      <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-zinc-400">
        <Loader2 className="h-3 w-3 animate-spin text-sky-400" />
        <span title="已运行时长">⏱ {elapsed}</span>
        {remainingMs !== undefined && (
          <span
            title="墙钟剩余时间"
            className={remainingMs <= 60_000 ? 'text-amber-300' : undefined}
          >
            剩 {formatElapsed(Math.max(0, remainingMs))}
          </span>
        )}
        {run.turn > 0 && (
          <span title="轮次">
            第 {run.turn}{run.maxTurns > 0 ? `/${run.maxTurns}` : ''} 轮
          </span>
        )}
        {run.tokenBudget > 0 && (
          <span title="token 用量">
            {run.tokensUsed.toLocaleString()}/{run.tokenBudget.toLocaleString()} tok
          </span>
        )}
        {gateHint && <span className="text-sky-300">{gateHint}</span>}
      </span>
    </div>
  );
};
