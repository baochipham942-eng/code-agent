import type { DesktopActivityEvent } from '@shared/contract';
import { guardSensitiveText } from '../../security/sensitiveDataGuard';

const ACTIVITY_LOCAL_PERSIST_MAX_CHARS = 8_000;

export interface LocalActivityPrivacyOptions {
  hideScreenshotPath?: boolean;
}

export function sanitizeLocalActivityText(
  value: unknown,
  maxLength = ACTIVITY_LOCAL_PERSIST_MAX_CHARS,
): string {
  return guardSensitiveText(value, {
    surface: 'activity',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

export function sanitizeLocalActivityOptional(
  value: unknown,
  maxLength = ACTIVITY_LOCAL_PERSIST_MAX_CHARS,
): string | null {
  const sanitized = sanitizeLocalActivityText(value, maxLength);
  return sanitized || null;
}

export function sanitizeLocalActivityEvent(
  event: DesktopActivityEvent,
  options: LocalActivityPrivacyOptions = {},
): DesktopActivityEvent {
  return {
    ...event,
    appName: sanitizeLocalActivityText(event.appName, 1_000) || event.appName,
    bundleId: sanitizeLocalActivityOptional(event.bundleId, 1_000),
    windowTitle: sanitizeLocalActivityOptional(event.windowTitle),
    browserUrl: sanitizeLocalActivityOptional(event.browserUrl),
    browserTitle: sanitizeLocalActivityOptional(event.browserTitle),
    documentPath: sanitizeLocalActivityOptional(event.documentPath),
    sessionState: sanitizeLocalActivityOptional(event.sessionState),
    powerSource: sanitizeLocalActivityOptional(event.powerSource, 1_000),
    screenshotPath: options.hideScreenshotPath && event.screenshotPath
      ? '[screenshot hidden]'
      : event.screenshotPath ?? null,
    analyzeText: sanitizeLocalActivityOptional(event.analyzeText),
  };
}
