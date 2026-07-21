import React, { useMemo } from 'react';
import { useI18n } from '../../../hooks/useI18n';
import {
  getSurfaceExecutionTranslations,
  formatSurfaceExecutionCopy,
} from '../../../i18n/surfaceExecution';
import {
  surfaceExecutionScopeKeyV1,
  type RendererSurfaceSessionProjectionV1,
} from '../../../utils/surfaceExecutionProjection';
import { SurfaceExecutionCard } from './SurfaceExecutionCard';
import type { SurfaceExecutionConversationPanelProps } from './types';

function eventBelongsToSession(
  event: RendererSurfaceSessionProjectionV1['events'][number],
  projection: RendererSurfaceSessionProjectionV1,
): boolean {
  return event.sessionId === projection.scope.surfaceSessionId
    && event.runId === projection.scope.runId
    && event.agentId === projection.scope.agentId
    && (event.conversationId === undefined || event.conversationId === projection.scope.conversationId);
}

function selectSurfaceConversationSessions(
  conversationId: string,
  projection: SurfaceExecutionConversationPanelProps['projection'],
  sessions: SurfaceExecutionConversationPanelProps['sessions'],
): RendererSurfaceSessionProjectionV1[] {
  const candidates = sessions ?? (
    projection?.conversationId === conversationId ? projection.sessions : []
  );
  const byScope = new Map<string, RendererSurfaceSessionProjectionV1>();

  for (const candidate of candidates) {
    if (
      candidate.scope.conversationId !== conversationId
      || candidate.session.conversationId !== conversationId
    ) continue;
    const isolated = {
      ...candidate,
      events: candidate.events.filter((event) => eventBelongsToSession(event, candidate)),
    };
    const key = surfaceExecutionScopeKeyV1(candidate.scope);
    const existing = byScope.get(key);
    if (!existing || isolated.updatedAt >= existing.updatedAt) byScope.set(key, isolated);
  }

  return Array.from(byScope.values()).sort((left, right) => (
    right.updatedAt - left.updatedAt
    || right.session.startedAt - left.session.startedAt
    || surfaceExecutionScopeKeyV1(left.scope).localeCompare(surfaceExecutionScopeKeyV1(right.scope))
  ));
}

export function SurfaceExecutionConversationPanel({
  conversationId,
  projection,
  sessions,
  onControl,
  translations,
  now,
  className = '',
}: SurfaceExecutionConversationPanelProps) {
  const { language } = useI18n();
  const copy = translations ?? getSurfaceExecutionTranslations(language);
  const visibleSessions = useMemo(
    () => selectSurfaceConversationSessions(conversationId, projection, sessions),
    [conversationId, projection, sessions],
  );

  if (visibleSessions.length === 0) return null;
  const mode = visibleSessions.every((session) => session.source === 'compat')
    ? 'compatibility'
    : 'native';
  const renderedAt = now ?? Date.now();

  return (
    <section
      aria-label={copy.panel.label}
      data-testid="surface-execution-conversation-panel"
      data-placement="conversation"
      data-mode={mode}
      className={`space-y-3 ${className}`.trim()}
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <div>
          <h2 className="text-xs font-medium text-zinc-300">{copy.panel.label}</h2>
          <p className="mt-0.5 text-[10px] text-zinc-600">
            {formatSurfaceExecutionCopy(copy.panel.sessionCount, { count: visibleSessions.length })}
          </p>
        </div>
        <span className="rounded-full border border-white/[0.06] bg-white/[0.02] px-2 py-1 text-[9px] text-zinc-500">
          {mode === 'compatibility' ? copy.panel.compatibility : copy.panel.native}
        </span>
      </div>

      {visibleSessions.map((session) => (
        <SurfaceExecutionCard
          key={surfaceExecutionScopeKeyV1(session.scope)}
          session={session}
          copy={copy}
          language={language}
          now={renderedAt}
          onControl={onControl}
        />
      ))}
    </section>
  );
}
