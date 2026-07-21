import React from 'react';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { formatSurfaceExecutionCopy } from '../../../i18n/surfaceExecution';
import { formatSurfaceTimestamp } from './surfaceExecutionPresentation';

interface SurfacePermissionCardProps {
  session: RendererSurfaceSessionProjectionV1;
  copy: SurfaceExecutionTranslationsV1;
  language: 'zh' | 'en';
}

const GRANT_TONE = {
  active: 'text-emerald-300',
  consumed: 'text-zinc-400',
  revoked: 'text-red-300',
  expired: 'text-amber-300',
  none: 'text-zinc-500',
} as const;

function grantLabel(
  state: RendererSurfaceSessionProjectionV1['grant']['state'],
  copy: SurfaceExecutionTranslationsV1,
): string {
  return {
    active: copy.permission.grantActive,
    consumed: copy.permission.grantConsumed,
    revoked: copy.permission.grantRevoked,
    expired: copy.permission.grantExpired,
    none: copy.permission.grantNone,
  }[state];
}

export function SurfacePermissionCard({ session, copy, language }: SurfacePermissionCardProps) {
  const { grant } = session;
  const isReadonly = session.source === 'compat' || !session.writable;

  return (
    <section
      data-testid="surface-permission-card"
      className="rounded-lg border border-white/[0.06] bg-black/10 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-medium text-zinc-300">{copy.permission.title}</h4>
        <span className={`text-[10px] ${GRANT_TONE[grant.state]}`}>{grantLabel(grant.state, copy)}</span>
      </div>

      {grant.capabilities.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label={copy.permission.capabilities}>
          {grant.capabilities.map((capability) => (
            <span
              key={capability}
              className="rounded border border-white/[0.06] bg-white/[0.025] px-1.5 py-0.5 text-[10px] text-zinc-400"
            >
              {copy.permission.capability[capability]}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
        <span>{formatSurfaceExecutionCopy(copy.permission.actionScope, { count: grant.actionClasses.length })}</span>
        <span>{formatSurfaceExecutionCopy(copy.permission.dataScope, { count: grant.dataScopes.length })}</span>
        {grant.expiresAt && (
          <span>{formatSurfaceExecutionCopy(copy.permission.expires, {
            time: formatSurfaceTimestamp(grant.expiresAt, language),
          })}</span>
        )}
      </div>

      {isReadonly && (
        <p className="mt-2 border-t border-white/[0.04] pt-2 text-[10px] leading-4 text-zinc-600">
          {copy.permission.readonly}
        </p>
      )}
    </section>
  );
}
