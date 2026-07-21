import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { formatSurfaceExecutionCopy } from '../../../i18n/surfaceExecution';
import {
  formatSurfaceDuration,
  formatSurfaceRelativeTime,
  surfaceControllerLabel,
  surfaceIsolationLabel,
  surfaceProviderLabel,
  surfaceStageLabel,
  surfaceTargetLabel,
} from './surfaceExecutionPresentation';

interface SurfaceSessionHeaderProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
  language: 'zh' | 'en';
  now: number;
}

const STATE_TONE: Record<RendererSurfaceSessionProjectionV1['session']['state'], string> = {
  preparing: 'border-sky-400/20 bg-sky-400/10 text-sky-200',
  waiting_permission: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  running: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  waiting_human: 'border-violet-400/20 bg-violet-400/10 text-violet-200',
  paused: 'border-zinc-400/20 bg-zinc-400/10 text-zinc-300',
  stopping: 'border-amber-400/20 bg-amber-400/10 text-amber-200',
  completed: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  failed: 'border-red-400/20 bg-red-400/10 text-red-200',
};

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</dt>
      <dd className="mt-0.5 truncate text-[11px] text-zinc-300" title={value}>{value}</dd>
    </div>
  );
}

export function SurfaceSessionHeader({
  session,
  copy,
  language,
  now,
}: SurfaceSessionHeaderProps) {
  const state = session.session.state;
  const elapsed = formatSurfaceDuration(Math.max(0, now - session.session.startedAt), language);
  const heartbeat = formatSurfaceRelativeTime(session.session.heartbeatAt, now, copy);
  const target = surfaceTargetLabel(session.session.activeTarget, copy);

  return (
    <header data-testid="surface-session-header" className="border-b border-white/[0.06] px-4 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-medium text-zinc-100">{target}</h3>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] ${STATE_TONE[state]}`}>
              {copy.state[state]}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">
            {surfaceStageLabel(session, copy)}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[11px] font-medium text-zinc-300">
            {copy.surface[session.session.surface]} · {surfaceProviderLabel(session, copy)}
          </div>
          <div className="mt-1 text-[10px] text-zinc-600">
            {formatSurfaceExecutionCopy(copy.timing.elapsed, { time: elapsed })}
          </div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/[0.04] pt-3 sm:grid-cols-3">
        <MetadataItem label={copy.controller.label} value={surfaceControllerLabel(session, copy)} />
        <MetadataItem label={copy.isolation.label} value={surfaceIsolationLabel(session, copy)} />
        <MetadataItem
          label={copy.timing.heartbeat.replace(' {time}', '')}
          value={heartbeat}
        />
      </dl>
    </header>
  );
}
