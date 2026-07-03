// ============================================================================
// GoalStatusBar - /goal 运行进度状态条
// ============================================================================
// 挂在 ChatInput 上方（独立一行，不与 Skill/MCP pill 混排）。
// running：目标 · 已运行时长(实时) · 墙钟剩余 · 第 N/M 轮 · token 用量 · 暂停按钮。
// paused（③）：整条转 slate 灰 · "目标已暂停" · 冻结时长 · 继续按钮（后端循环在 turn 边界挂起，goal 仍 pending）。
// 完成/中止后由聊天区的 GoalNoticeMessage 卡片接管，状态条自动隐藏。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Target, Loader2, Pause, Play } from 'lucide-react';
import { useAppStore, type GoalRunState } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { invokeDomain } from '../../../services/ipcService';
import { useI18n } from '../../../hooks/useI18n';

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

/** 纯展示层（store-free，测试直接喂 run） */
export const GoalStatusBarView: React.FC<{ run: GoalRunState; onTogglePause: () => void }> = ({
  run,
  onTogglePause,
}) => {
  const { t } = useI18n();

  // 实时计时器：仅运行中每秒刷新一次（暂停时冻结时长）
  const [now, setNow] = useState(() => Date.now());
  const running = run.status === 'running';
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const paused = run.status === 'paused';
  const elapsed = formatElapsed(now - run.startedAt);
  // 墙钟剩余（①）：仅当设了时间预算才显示，剩 0 时高亮提醒即将兜底中止
  const remainingMs =
    run.wallClockBudgetMs !== undefined ? run.wallClockBudgetMs - (now - run.startedAt) : undefined;
  const gateHint =
    run.lastGate?.gate === 1 ? t.goalStatusBar.verifying : run.lastGate?.gate === 2 ? t.goalStatusBar.reviewing : null;
  const togglePause = onTogglePause;

  const accent = paused
    ? 'border-slate-500/30 bg-slate-500/[0.07]'
    : 'border-sky-500/30 bg-sky-500/[0.07]';

  return (
    <div className={`goal-status-bar mx-auto mb-1 flex w-full max-w-3xl items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${accent}`}>
      <Target className={`h-3.5 w-3.5 flex-shrink-0 ${paused ? 'text-slate-400' : 'text-sky-400'}`} />
      <span className="truncate text-zinc-300" title={run.goal}>
        {paused ? t.goalStatusBar.pausedPrefix : t.goalStatusBar.runningPrefix}
        <span className="text-zinc-100">{run.goal}</span>
      </span>
      <span className="ml-auto flex flex-shrink-0 items-center gap-2 text-zinc-400">
        {!paused && <Loader2 className="h-3 w-3 animate-spin text-sky-400" />}
        <span title={t.goalStatusBar.elapsedTitle}>⏱ {elapsed}</span>
        {remainingMs !== undefined && (
          <span
            title={t.goalStatusBar.remainingTitle}
            className={remainingMs <= 60_000 ? 'text-amber-300' : undefined}
          >
            {t.goalStatusBar.remainingPrefix}{formatElapsed(Math.max(0, remainingMs))}
          </span>
        )}
        {run.turn > 0 && (
          <span title={t.goalStatusBar.turnTitle}>
            {t.goalStatusBar.turnPrefix}{run.turn}{run.maxTurns > 0 ? `/${run.maxTurns}` : ''}{t.goalStatusBar.turnSuffix}
          </span>
        )}
        {run.tokenBudget > 0 && (
          <span title={t.goalStatusBar.tokenTitle}>
            {run.tokensUsed.toLocaleString()}/{run.tokenBudget.toLocaleString()} tok
          </span>
        )}
        {!paused && gateHint && <span className="text-sky-300">{gateHint}</span>}
        <button
          type="button"
          data-goal-toggle-pause
          onClick={togglePause}
          title={paused ? t.goalStatusBar.resume : t.goalStatusBar.pause}
          className="flex-shrink-0 rounded p-0.5 text-zinc-400 transition-colors hover:text-zinc-100"
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </button>
      </span>
    </div>
  );
};

export const GoalStatusBar: React.FC = () => {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const run = useAppStore((s) => (currentSessionId ? s.goalRuns[currentSessionId] : undefined));
  const setGoalPaused = useAppStore((s) => s.setGoalPaused);

  if (run?.status !== 'running' && run?.status !== 'paused') return null;

  const togglePause = () => {
    if (!currentSessionId) return;
    const next = run.status !== 'paused';
    // 后端复用通用 pause/resume：循环在 turn 边界（waitWhilePaused）挂起/释放
    invokeDomain('domain:agent', next ? 'pause' : 'resume', { sessionId: currentSessionId }).catch(() => {});
    setGoalPaused(currentSessionId, next);
  };

  return <GoalStatusBarView run={run} onTogglePause={togglePause} />;
};
