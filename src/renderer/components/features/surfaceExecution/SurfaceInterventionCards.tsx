import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { latestSurfaceEvent, safeSurfaceText } from './surfaceExecutionPresentation';

interface SurfaceInterventionCardProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
}

export function SurfaceHumanTakeoverCard({ session, copy }: SurfaceInterventionCardProps) {
  const event = latestSurfaceEvent(session);
  const detail = event?.phase === 'human'
    ? safeSurfaceText(event.userSummary, copy.takeover.description, 180)
    : copy.takeover.description;

  return (
    <section
      data-testid="surface-human-takeover-card"
      className="rounded-lg border border-violet-400/20 bg-violet-400/[0.05] p-3"
    >
      <h4 className="text-[11px] font-medium text-violet-200">{copy.takeover.title}</h4>
      <p className="mt-1 text-[10px] leading-4 text-violet-100/60">{detail}</p>
    </section>
  );
}

export function SurfaceRecoveryCard({ session, copy }: SurfaceInterventionCardProps) {
  const event = latestSurfaceEvent(session);
  const detail = event?.phase === 'recover'
    ? safeSurfaceText(event.userSummary, copy.recovery.description, 180)
    : copy.recovery.description;

  return (
    <section
      data-testid="surface-recovery-card"
      className="rounded-lg border border-amber-400/20 bg-amber-400/[0.05] p-3"
    >
      <h4 className="text-[11px] font-medium text-amber-200">{copy.recovery.title}</h4>
      <p className="mt-1 text-[10px] leading-4 text-amber-100/60">{detail}</p>
    </section>
  );
}
