import React from 'react';
import type { SurfaceExecutionEventV1 } from '@shared/contract/surfaceExecution';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { safeSurfaceText } from './surfaceExecutionPresentation';

interface SurfaceSemanticTimelineProps {
  events: readonly SurfaceExecutionEventV1[];
  copy: SurfaceExecutionTranslationsV1;
}

function eventTone(event: SurfaceExecutionEventV1): string {
  if (event.status === 'failed') return 'border-red-400/30 bg-red-400/5';
  if (event.status === 'ambiguous') return 'border-amber-400/30 bg-amber-400/5';
  if (event.phase === 'human') return 'border-violet-400/30 bg-violet-400/5';
  if (event.phase === 'verify') return 'border-emerald-400/20 bg-emerald-400/[0.03]';
  return 'border-white/[0.06] bg-white/[0.015]';
}

function TimelineFinding({ finding }: {
  finding: string;
}) {
  const safe = safeSurfaceText(finding, '', 160);
  if (!safe) return null;
  return <li className="leading-4 text-zinc-500">{safe}</li>;
}

function TimelineEvent({ event, copy }: {
  event: SurfaceExecutionEventV1;
  copy: SurfaceExecutionTranslationsV1;
}) {
  const summary = safeSurfaceText(event.userSummary, copy.fallback.stage, 220);
  const findings = (event.observation?.findings ?? []).slice(0, 3);

  return (
    <li
      data-testid="surface-timeline-event"
      data-phase={event.phase}
      data-status={event.status}
      className={`relative rounded-lg border px-3 py-2.5 ${eventTone(event)}`}
    >
      <span className="absolute -left-[17px] top-3 h-2 w-2 rounded-full border border-zinc-700 bg-zinc-400" />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
          {copy.timeline.phase[event.phase]}
        </span>
        <span className="text-[10px] text-zinc-600">{copy.timeline.status[event.status]}</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-zinc-300">{summary}</p>
      {event.observation && (
        <div className="mt-2 border-t border-white/[0.04] pt-2">
          <div className="flex items-center gap-2 text-[10px]">
            <span className="text-zinc-600">{copy.timeline.findings}</span>
            <span className="text-zinc-400">{copy.timeline.verdict[event.observation.verdict]}</span>
          </div>
          {findings.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[10px]">
              {findings.map((finding, index) => (
                <TimelineFinding key={`${event.eventId}:finding:${index}`} finding={finding} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

export function SurfaceSemanticTimeline({ events, copy }: SurfaceSemanticTimelineProps) {
  return (
    <section data-testid="surface-semantic-timeline" className="px-4 py-3">
      <h4 className="text-[11px] font-medium text-zinc-300">{copy.timeline.title}</h4>
      {events.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-600">{copy.timeline.empty}</p>
      ) : (
        <ol
          aria-label={copy.timeline.title}
          className="relative mt-2 space-y-2 border-l border-white/[0.08] pl-3"
        >
          {events.map((event) => <TimelineEvent key={event.eventId} event={event} copy={copy} />)}
        </ol>
      )}
    </section>
  );
}
