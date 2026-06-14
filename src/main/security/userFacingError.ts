// ============================================================================
// User-facing Error Boundary
// ============================================================================

import { guardSensitiveText } from './sensitiveDataGuard';

export type UserFacingErrorSurface =
  | 'channel_reply'
  | 'desktop_notification'
  | 'http_api'
  | 'renderer_toast'
  | 'generic';

export interface UserFacingErrorOptions {
  surface?: UserFacingErrorSurface;
  fallback?: string;
  maxLength?: number;
}

export interface UserFacingErrorSummary {
  summary: string;
  retryHint: string;
}

const DEFAULT_FALLBACK = '处理失败，请稍后重试或查看本机诊断。';
const DEFAULT_RETRY_HINT = '完整错误已保留在本机诊断日志中。';

export function summarizeUserFacingError(
  error: unknown,
  options: UserFacingErrorOptions = {},
): UserFacingErrorSummary {
  const raw = extractErrorText(error);
  const compact = compactErrorText(raw);
  const scrubbed = scrubUserFacingText(compact || options.fallback || DEFAULT_FALLBACK, {
    surface: options.surface,
    maxLength: options.maxLength ?? 240,
  });

  return {
    summary: scrubbed || options.fallback || DEFAULT_FALLBACK,
    retryHint: DEFAULT_RETRY_HINT,
  };
}

export function formatUserFacingError(
  error: unknown,
  options: UserFacingErrorOptions = {},
): string {
  const { summary, retryHint } = summarizeUserFacingError(error, options);
  return `${summary}\n${retryHint}`;
}

export function scrubUserFacingText(
  value: unknown,
  options: Pick<UserFacingErrorOptions, 'surface' | 'maxLength'> = {},
): string {
  const preScrubbed = String(value ?? '')
    .replace(/\b(?:\/Users|\/private|\/tmp|\/var|\/home)\/[^\s,;:)]+/g, '[path hidden]')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{6,}/gi, 'Bearer ***REDACTED***')
    .replace(/\bgh[pousr]_[a-zA-Z0-9_]{12,}/g, '[secret hidden]')
    .replace(/\bsk-(?:proj-)?[a-zA-Z0-9_-]{20,}/g, '[secret hidden]');

  const guarded = guardSensitiveText(preScrubbed, {
    surface: 'telemetry',
    mode: 'diagnostic',
    maxLength: options.maxLength ?? 500,
    preserveLines: false,
  });
  return compactErrorText(guarded)
    .replace(/\b(?:\/Users|\/private|\/tmp|\/var|\/home)(?:\/[^\s,;:)]+)?/g, '[path hidden]')
    .replace(/\bgh[pousr]_(?:[a-zA-Z0-9_]+|\.\.\.[a-zA-Z0-9_]+)/g, '[secret hidden]')
    .replace(/\bBearer\s+\*\*\*REDACTED\*\*\*\s+[^\s,;:)]+/gi, 'Bearer ***REDACTED***')
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]{6,}/gi, 'Bearer ***REDACTED***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, options.maxLength ?? 500);
}

function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || DEFAULT_FALLBACK;
  }
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message = record.message ?? record.error ?? record.reason;
    if (typeof message === 'string') return message;
  }
  return String(error || DEFAULT_FALLBACK);
}

function compactErrorText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s+/.test(line) && !/^stack:/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
