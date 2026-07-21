import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import type { SurfaceExecutionControlHandlerV1 } from './types';
import { SurfaceControls } from './SurfaceControls';
import { SurfaceEvidenceList } from './SurfaceEvidenceList';
import { SurfaceHumanTakeoverCard, SurfaceRecoveryCard } from './SurfaceInterventionCards';
import { SurfacePermissionCard } from './SurfacePermissionCard';
import { SurfaceResourceSections } from './SurfaceResourceSections';
import { SurfaceSemanticTimeline } from './SurfaceSemanticTimeline';
import { SurfaceSessionHeader } from './SurfaceSessionHeader';
import { surfaceNeedsRecovery, surfaceNeedsTakeover } from './surfaceExecutionPresentation';

interface SurfaceExecutionCardProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
  language: 'zh' | 'en';
  now: number;
  onControl?: SurfaceExecutionControlHandlerV1;
}

export function SurfaceExecutionCard({
  session,
  copy,
  language,
  now,
  onControl,
}: SurfaceExecutionCardProps) {
  const takeover = surfaceNeedsTakeover(session);
  const recovery = surfaceNeedsRecovery(session);

  return (
    <article
      data-testid="surface-execution-session"
      data-source={session.source}
      data-surface={session.session.surface}
      data-state={session.session.state}
      className="overflow-hidden rounded-xl border border-white/[0.08] bg-zinc-950/50 shadow-sm"
    >
      <SurfaceSessionHeader session={session} copy={copy} language={language} now={now} />

      <div className={`grid gap-2 px-4 pt-3 ${takeover || recovery ? 'sm:grid-cols-2' : ''}`}>
        <SurfacePermissionCard session={session} copy={copy} language={language} />
        {takeover && <SurfaceHumanTakeoverCard session={session} copy={copy} />}
        {recovery && <SurfaceRecoveryCard session={session} copy={copy} />}
      </div>

      <SurfaceSemanticTimeline events={session.events} copy={copy} />
      <SurfaceEvidenceList
        evidence={session.evidence}
        copy={copy}
        language={language}
        scope={session.scope}
      />
      <SurfaceResourceSections session={session} copy={copy} />
      <SurfaceControls session={session} copy={copy} onControl={onControl} />
    </article>
  );
}
