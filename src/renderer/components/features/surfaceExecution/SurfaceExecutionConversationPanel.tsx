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
import { SurfaceExecutionCompactBar } from './SurfaceExecutionCompactBar';
import { surfaceNeedsInteraction } from './surfaceExecutionPresentation';
import type { SurfaceExecutionConversationPanelProps } from './types';

/**
 * B1-R·R3 行内投影二分：有右栏 workbench 浏览器现场后，行内只保留
 * 「需要用户此刻动手」的完整会话卡；常规执行中/已结束收敛为一行紧凑条。
 * 非 browser surface（本机电脑）右栏没有对应现场，保持完整卡；
 * 历史兼容记录（compat）没有可跳转的现场，同样保持完整卡。
 */
function surfaceNeedsFullCard(session: RendererSurfaceSessionProjectionV1): boolean {
  return session.session.surface !== 'browser'
    || session.source === 'compat'
    || surfaceNeedsInteraction(session);
}

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
  // 全部会话都收敛为紧凑条时，面板头（标题 + 会话计数 + 账本徽标）一并省掉，
  // 它只服务于完整卡的导读；只要有一张完整卡就保留。
  const hasFullCard = visibleSessions.some(surfaceNeedsFullCard);

  return (
    <section
      aria-label={copy.panel.label}
      data-testid="surface-execution-conversation-panel"
      data-placement="conversation"
      data-mode={mode}
      className={`space-y-3 ${className}`.trim()}
    >
      {hasFullCard && (
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
      )}

      {visibleSessions.map((session) => (
        surfaceNeedsFullCard(session) ? (
          <SurfaceExecutionCard
            key={surfaceExecutionScopeKeyV1(session.scope)}
            session={session}
            copy={copy}
            language={language}
            now={renderedAt}
            onControl={onControl}
          />
        ) : (
          <SurfaceExecutionCompactBar
            key={surfaceExecutionScopeKeyV1(session.scope)}
            session={session}
            copy={copy}
          />
        )
      ))}
    </section>
  );
}
