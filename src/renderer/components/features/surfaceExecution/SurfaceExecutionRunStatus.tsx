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
  preparing: 'text-sky-300',
  waiting_permission: 'text-amber-300',
  running: 'text-emerald-300',
  waiting_human: 'text-violet-300',
  paused: 'text-amber-300',
  stopping: 'text-amber-300',
  completed: 'text-emerald-300',
  failed: 'text-red-300',
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
  return useSurfaceExecutionStore((state) => selectSurfaceExecutionRunSessionV1(
    state.sessionsByScope,
    { conversationId },
  ));
}

interface SurfaceExecutionRunStatusProps {
  session: RendererSurfaceSessionProjectionV1;
  placement: 'sidebar' | 'composer';
}

export function SurfaceExecutionRunStatus({
  session,
  placement,
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

  if (placement === 'sidebar') {
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

  return (
    <div
      data-testid="surface-execution-composer-status"
      data-placement="composer"
      data-state={state}
      data-surface={session.session.surface}
      className={`mb-2 flex items-center gap-1.5 px-2 text-[11px] ${STATE_TONE[state]}`}
      aria-label={label}
    >
      {marker}
      <span>{label}</span>
    </div>
  );
}

export function SurfaceExecutionComposerStatus({
  conversationId,
}: { conversationId: string | null }) {
  const session = useSurfaceExecutionRunSession(conversationId);
  return session ? <SurfaceExecutionRunStatus session={session} placement="composer" /> : null;
}
