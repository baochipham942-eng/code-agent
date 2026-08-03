import React from 'react';
import { Loader2 } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';
import { getSurfaceExecutionTranslations } from '../../../i18n/surfaceExecution';
import {
  selectSurfaceExecutionRunSessionV1,
  useSurfaceExecutionStore,
} from '../../../stores/surfaceExecutionStore';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';

type SurfaceRunState = RendererSurfaceSessionProjectionV1['session']['state'];

const STATE_TONE: Record<SurfaceRunState, string> = {
  preparing: 'text-badge-info',
  waiting_permission: 'text-badge-warning',
  running: 'text-badge-success',
  waiting_human: 'text-badge-accent',
  paused: 'text-badge-warning',
  stopping: 'text-badge-warning',
  completed: 'text-badge-success',
  failed: 'text-badge-danger',
};

const DOT_TONE: Record<SurfaceRunState, string> = {
  preparing: 'bg-sky-400',
  waiting_permission: 'bg-amber-400',
  running: 'bg-emerald-400',
  waiting_human: 'bg-violet-400',
  paused: 'bg-amber-400',
  stopping: 'bg-amber-400',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
};

const SPINNING_STATES = new Set<SurfaceRunState>(['preparing', 'running', 'stopping']);

export function useSurfaceExecutionRunSession(conversationId: string | null) {
  // 产品拍板（2026-08-01）：侧栏圆点只报进行中的 surface，终态（completed/failed）
  // 不常驻——结果由会话内的行内紧凑条承载。
  // 产品拍板（2026-08-02）：composer 上方那条常驻状态条已删。它跟对话流里的
  // SurfaceExecutionCompactBar 报的是同一件事，而后者还带「操作到哪一步」，
  // 复述一遍只是噪音。侧栏圆点留着——它的职责不同：告诉你**别的**会话在忙。
  // excludeUserOpened 只有「有人在干活」类提示才传——右栏 workbench 和画中画不传，
  // 它们必须拿得到用户自己点开的那扇窗。
  return useSurfaceExecutionStore((state) => selectSurfaceExecutionRunSessionV1(
    state.sessionsByScope,
    { conversationId, includeTerminal: false, excludeUserOpened: true },
  ));
}

interface SurfaceExecutionRunStatusProps {
  session: RendererSurfaceSessionProjectionV1;
}

export function SurfaceExecutionRunStatus({
  session,
}: SurfaceExecutionRunStatusProps) {
  const { language } = useI18n();
  const copy = getSurfaceExecutionTranslations(language);
  const state = session.session.state;
  const label = `${copy.surface[session.session.surface]} · ${copy.state[state]}`;
  const marker = SPINNING_STATES.has(state) ? (
    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
  ) : (
    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[state]}`} aria-hidden />
  );

  return (
    <span
      data-testid="surface-execution-sidebar-status"
      data-placement="sidebar"
      data-state={state}
      data-surface={session.session.surface}
      className={`inline-flex items-center ${STATE_TONE[state]}`}
      aria-label={label}
      title={label}
    >
      {marker}
    </span>
  );
}
