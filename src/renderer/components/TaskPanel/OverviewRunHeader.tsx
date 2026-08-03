// ============================================================================
// OverviewRunHeader —— 概览主视线第一层：当前轮的进度与干预（T1）
// ----------------------------------------------------------------------------
// 无 run 时整块不渲染（工单：不摆空 Run header）。中断走 useAgent 既有的
// cancel（agent:cancel IPC），经 runControlStore 投影过来，这里不自己发 IPC。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useRunWorkbenchModel } from '../../hooks/useRunWorkbenchModel';
import { useRunControlStore } from '../../stores/runControlStore';
import { useSessionStore } from '../../stores/sessionStore';
import { getDisplaySessionTitle } from '../../utils/sessionPresentation';
import {
  buildOverviewRunHeaderModel,
  formatElapsedClock,
  isLiveRunStatus,
} from '../../utils/overviewRunHeader';
import { GhostButton } from '../primitives';
import { runStatusClass, getRunUiStatusLabel } from './RunWorkbenchCards';

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
  const model = buildOverviewRunHeaderModel({ run: runWorkbench.run, sessionTitle, now });

  if (!model) return null;

  return (
    <div
      data-testid="overview-run-header"
      data-run-status={model.status}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2"
    >
      {model.live && (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-badge-info" />
      )}
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-xs font-medium text-zinc-200"
          data-testid="overview-run-header-title"
          title={model.title}
        >
          {model.title}
        </div>
        {model.phase && (
          <div className="truncate text-[11px] text-zinc-500" title={model.phase}>
            {model.phase}
          </div>
        )}
      </div>
      <span
        data-testid="overview-run-header-status"
        className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${runStatusClass(model.status)}`}
      >
        {getRunUiStatusLabel(model.status, t)}
      </span>
      {model.elapsedMs !== null && (
        <span
          data-testid="overview-run-header-elapsed"
          className="shrink-0 text-[11px] tabular-nums text-zinc-500"
          title={t.workbenchTabs.overviewRunElapsedLabel}
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
          {t.workbenchTabs.overviewRunInterrupt}
        </GhostButton>
      )}
    </div>
  );
};
