import type {
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
  SurfaceSessionControlActionV1,
  SurfaceTargetRefV1,
} from '@shared/contract/surfaceExecution';
import { redactSurfaceExecutionValue } from '@shared/utils/surfaceExecutionRedaction';
import type { RendererSurfaceSessionProjectionV1 } from '../../../utils/surfaceExecutionProjection';
import type { SurfaceExecutionTranslationsV1 } from '../../../i18n/surfaceExecution';
import { formatSurfaceExecutionCopy } from '../../../i18n/surfaceExecution';

const INTERNAL_ASSIGNMENT = /\b(?:selector|grantId|traceId|toolName|backendNodeId|tabRef|windowRef)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CONTROL_ACTIONS: readonly SurfaceSessionControlActionV1[] = [
  'pause',
  'resume',
  'continue',
  'takeover',
  'stop',
  'end_session',
];

export function safeSurfaceText(value: unknown, fallback: string, maxLength = 180): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) return fallback;
  const redacted = redactSurfaceExecutionValue(value);
  if (typeof redacted !== 'string') return fallback;
  const safe = redacted.replace(INTERNAL_ASSIGNMENT, '').replace(/\s{2,}/g, ' ').trim();
  if (!safe) return fallback;
  return safe.length > maxLength ? `${safe.slice(0, maxLength - 1)}…` : safe;
}

function browserDomain(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

export function surfaceTargetLabel(
  target: SurfaceTargetRefV1 | undefined,
  copy: SurfaceExecutionTranslationsV1,
): string {
  if (!target) return copy.target.unavailable;
  if (target.kind === 'browser') {
    const title = safeSurfaceText(target.title, '', 90);
    const domain = safeSurfaceText(browserDomain(target.origin), '', 100);
    return [title, domain].filter(Boolean).join(' · ') || copy.target.browser;
  }
  const appName = safeSurfaceText(target.appName, '', 60);
  const title = safeSurfaceText(target.title, '', 90);
  return [appName, title].filter((part, index, parts) => part && parts.indexOf(part) === index).join(' · ')
    || copy.target.computer;
}

export function surfaceSourceLabel(
  target: SurfaceTargetRefV1 | undefined,
  copy: SurfaceExecutionTranslationsV1,
): string | null {
  if (!target) return null;
  return surfaceTargetLabel(target, copy);
}

export function surfaceProviderLabel(
  session: RendererSurfaceSessionProjectionV1,
  copy: SurfaceExecutionTranslationsV1,
): string {
  const provider = session.session.provider.toLowerCase();
  if (provider.includes('relay')) return copy.provider.relay;
  if (session.session.surface === 'computer') return copy.provider.computer;
  if (provider.includes('managed') || provider.includes('playwright') || provider.includes('cdp')) {
    return copy.provider.managed;
  }
  return copy.provider.other;
}

export function surfaceIsolationLabel(
  session: RendererSurfaceSessionProjectionV1,
  copy: SurfaceExecutionTranslationsV1,
): string {
  const provider = session.session.provider.toLowerCase();
  if (provider.includes('relay')) return copy.isolation.relay;
  if (session.session.surface === 'computer') return copy.isolation.computer;
  if (provider.includes('managed') || provider.includes('playwright') || provider.includes('cdp')) {
    return copy.isolation.managed;
  }
  return copy.isolation.other;
}

export function latestSurfaceEvent(
  session: RendererSurfaceSessionProjectionV1,
): SurfaceExecutionEventV1 | undefined {
  return session.events[session.events.length - 1];
}

export function surfaceStageLabel(
  session: RendererSurfaceSessionProjectionV1,
  copy: SurfaceExecutionTranslationsV1,
): string {
  return safeSurfaceText(latestSurfaceEvent(session)?.userSummary, copy.fallback.stage, 180);
}

export function surfaceControllerLabel(
  session: RendererSurfaceSessionProjectionV1,
  copy: SurfaceExecutionTranslationsV1,
): string {
  if (!session.writable || session.source === 'compat') return copy.controller.archive;
  if (session.session.state === 'waiting_human') return copy.controller.human;
  return copy.controller.agent;
}

export function surfaceControlActions(
  session: RendererSurfaceSessionProjectionV1,
): SurfaceSessionControlActionV1[] {
  if (session.source === 'compat') return [];
  if (!session.writable) {
    return session.source === 'persisted' && session.availableControls.includes('continue')
      ? ['continue']
      : [];
  }
  return session.availableControls.filter((value): value is SurfaceSessionControlActionV1 => (
    CONTROL_ACTIONS.includes(value as SurfaceSessionControlActionV1)
  ));
}

export function surfaceNeedsTakeover(session: RendererSurfaceSessionProjectionV1): boolean {
  if (session.session.state === 'waiting_human') return true;
  const event = latestSurfaceEvent(session);
  return event?.phase === 'human' && (event.status === 'waiting' || event.status === 'running');
}

export function surfaceNeedsRecovery(session: RendererSurfaceSessionProjectionV1): boolean {
  if (session.session.state === 'failed') return true;
  const event = latestSurfaceEvent(session);
  return event?.phase === 'recover' && event.status !== 'succeeded';
}

export function hasVerifiedInspection(evidence: SurfaceEvidenceCardV1): boolean {
  return evidence.inspection.analysisState === 'analyzed'
    && Boolean(evidence.inspection.inspectedBy)
    && typeof evidence.inspection.inspectedAt === 'number';
}

export function formatSurfaceDuration(durationMs: number, language: 'zh' | 'en'): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return language === 'en' ? `${seconds}s` : `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return language === 'en' ? `${minutes}m` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return language === 'en' ? `${hours}h ${minutes % 60}m` : `${hours} 小时 ${minutes % 60} 分钟`;
}

export function formatSurfaceRelativeTime(
  timestamp: number,
  now: number,
  copy: SurfaceExecutionTranslationsV1,
): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return copy.timing.justNow;
  if (minutes < 60) return formatSurfaceExecutionCopy(copy.timing.minutes, { count: minutes });
  return formatSurfaceExecutionCopy(copy.timing.hours, { count: Math.floor(minutes / 60) });
}

export function formatSurfaceTimestamp(timestamp: number, language: 'zh' | 'en'): string {
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}
