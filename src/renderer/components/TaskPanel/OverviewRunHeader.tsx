// ============================================================================
// OverviewRunHeader —— 概览四模块 · 模块一「任务」：细进度线（2026-08-04 拍板二/三）
// ----------------------------------------------------------------------------
// 一行裸文字：状态点 + 当前/最近 run 指令 + 步骤计数 + 用时 + 中断；当前动作句（run.phase
// 人话）放第二行小字。三态仅靠状态点颜色 + 文案差异，无卡片、无边框、无底色块：
//   live    —— --mark-info 蓝点 + 呼吸（motion-reduce 静止），秒表走字，给中断
//   waiting —— waiting_approval 并入进行中（D3）：--mark-warning 黄点 + 「等你确认」
//   done    —— --mark-success 绿点，秒表定格，动作句消失，中断消失
//   error   —— --mark-danger 红点 + 人话结局（「已中断」「出错了」），不露内部状态名
// 无 run 时整条不渲染（不摆空表头）。中断走 runControlStore 投影过来的
// useAgent cancel，这里不自己发 IPC。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useRunWorkbenchModel } from '../../hooks/useRunWorkbenchModel';
import { useRunControlStore } from '../../stores/runControlStore';
import { useSessionStore } from '../../stores/sessionStore';
import { getDisplaySessionTitle } from '../../utils/sessionPresentation';
import {
  buildOverviewRunHeaderModel,
  formatElapsedClock,
  isLiveRunStatus,
  type RunOverviewTone,
} from '../../utils/overviewRunHeader';
import { summarizeTodoProgress } from './TaskWorkspaceOverview';
import { GhostButton } from '../primitives';

const ELAPSED_TICK_MS = 1000;

/** 只在活跃回合里走秒表；跑完就停，避免空转重渲染整个右栏。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const DOT_CLASS: Record<RunOverviewTone, string> = {
  // 呼吸 = opacity 脉冲；motion-reduce 下静止（spec §1 模块一视觉处理）
  live: 'bg-mark-info motion-safe:animate-pulse',
  waiting: 'bg-mark-warning',
  done: 'bg-mark-success',
  error: 'bg-mark-danger',
};

function formatTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export const OverviewRunHeader: React.FC = () => {
  const { t } = useI18n();
  const runWorkbench = useRunWorkbenchModel();
  const interrupt = useRunControlStore((state) => state.actions?.interrupt);
  const sessionTitle = useSessionStore((state) => {
    const session = state.sessions.find((item) => item.id === state.currentSessionId);
    return session ? getDisplaySessionTitle(session.title) : null;
  });

  // 秒表只在活跃回合里装 interval；无 run 时 hook 照样要调用（hooks 规则），
  // 但 active=false 不会起定时器。
  const now = useNow(isLiveRunStatus(runWorkbench.run.status));
  const model = buildOverviewRunHeaderModel({
    run: runWorkbench.run,
    sessionTitle,
    now,
    todoProgress: summarizeTodoProgress(runWorkbench.tasks),
  });

  if (!model) return null;

  const wt = t.workbenchTabs;
  const toneLabel = model.tone === 'waiting'
    ? wt.overviewRunWaitingApproval
    : model.outcome === 'cancelled'
      ? wt.overviewRunOutcomeCancelled
      : model.outcome === 'error'
        ? wt.overviewRunOutcomeError
        : model.live
          ? wt.overviewProgressLabel
          : wt.overviewRunStepsDone.replace('{total}', String(model.steps?.total ?? 0));

  // 第二行小字：waiting → 「等你确认」；error → 人话结局；live → 当前动作句
  const phaseLine = model.tone === 'waiting'
    ? wt.overviewRunWaitingApproval
    : model.outcome
      ? (model.outcome === 'cancelled' ? wt.overviewRunOutcomeCancelled : wt.overviewRunOutcomeError)
      : model.phase;

  return (
    <div data-testid="overview-run-header" data-run-status={model.status} className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 px-0.5">
        <span
          data-testid="overview-run-header-dot"
          data-tone={model.tone}
          role="img"
          aria-label={formatTemplate(wt.overviewRunDotLabel, { status: toneLabel })}
          className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[model.tone]}`}
        />
        <span
          className="min-w-0 truncate text-sm font-medium text-zinc-100"
          data-testid="overview-run-header-title"
          title={model.title}
        >
          {model.title}
        </span>
        {model.steps && (
          <span
            data-testid="overview-run-header-steps"
            className="shrink-0 text-[11px] text-zinc-500"
          >
            {model.live || model.tone === 'waiting'
              ? formatTemplate(wt.overviewRunStepProgress, {
                current: model.steps.current,
                total: model.steps.total,
              })
              : formatTemplate(wt.overviewRunStepsDone, { total: model.steps.total })}
          </span>
        )}
        {model.elapsedMs !== null && (
          <span
            data-testid="overview-run-header-elapsed"
            className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500"
            title={wt.overviewRunElapsedLabel}
          >
            {formatElapsedClock(model.elapsedMs)}
          </span>
        )}
        {model.live && interrupt && (
          <GhostButton
            size="sm"
            data-testid="overview-run-header-interrupt"
            leftIcon={<Square className="h-3 w-3" />}
            onClick={() => { void interrupt(); }}
          >
            {wt.overviewRunInterrupt}
          </GhostButton>
        )}
      </div>
      {phaseLine && (
        <div
          data-testid="overview-run-header-phase"
          className={`truncate px-0.5 pl-4 text-[11px] ${
            model.tone === 'error' ? 'text-badge-danger' : 'text-zinc-400'
          }`}
          title={phaseLine}
        >
          {phaseLine}
        </div>
      )}
    </div>
  );
};
