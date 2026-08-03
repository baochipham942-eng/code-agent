import React from 'react';
import { CheckCircle2, ChevronRight, Loader2 } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { formatSurfaceExecutionCopy } from '../../../i18n/surfaceExecution';
import { surfaceTargetDomain, surfaceTargetLabel } from './surfaceExecutionPresentation';

type SurfaceRunState = RendererSurfaceSessionProjectionV1['session']['state'];

const SPINNING_STATES: ReadonlySet<SurfaceRunState> = new Set(['preparing', 'running', 'stopping']);

interface SurfaceExecutionCompactBarProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
}

/**
 * B1-R·R3 行内投影的「无需用户动手」侧：一行紧凑状态条替代完整会话卡，
 * 右栏 workbench「浏览器」tab 已是现场，点击即跳转。样式对齐会话里既有的
 * inline 状态条（SurfaceExecutionRunStatus / TaskStatusBar 的视觉语言）。
 */
export function SurfaceExecutionCompactBar({ session, copy }: SurfaceExecutionCompactBarProps) {
  const openWorkbenchTab = useAppStore((state) => state.openWorkbenchTab);
  const state = session.session.state;
  const target = surfaceTargetDomain(session.session.activeTarget)
    ?? surfaceTargetLabel(session.session.activeTarget, copy);
  const detail = state === 'completed'
    ? copy.compact.completed
    : formatSurfaceExecutionCopy(copy.compact.active, { target });
  const label = `${copy.surface[session.session.surface]} · ${detail}`;

  return (
    <button
      type="button"
      data-testid="surface-execution-compact-bar"
      data-state={state}
      data-surface={session.session.surface}
      aria-label={`${label} · ${copy.compact.open}`}
      title={copy.compact.open}
      onClick={() => openWorkbenchTab('browser', { source: 'user' })}
      className="flex w-full items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
    >
      {state === 'completed' ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-badge-success" aria-hidden />
      ) : SPINNING_STATES.has(state) ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-badge-success" aria-hidden />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-mark-warning" aria-hidden />
      )}
      <span className="min-w-0 truncate">{label}</span>
      <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-zinc-500" aria-hidden />
    </button>
  );
}
