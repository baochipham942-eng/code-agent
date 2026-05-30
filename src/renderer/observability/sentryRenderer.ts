// ============================================================================
// Sentry (Renderer) - React 渲染层的崩溃与未捕获错误上报
// ============================================================================
//
// DSN 从构建期注入的 VITE_SENTRY_DSN 读取（缺省则禁用 = no-op）。
// beforeSend 复用 shared/scrubEvent 脱敏（renderer 拿不到家目录，故不传 homeDir）。
// 与 ErrorBoundary 配合：组件树渲染错误经 componentDidCatch 主动上报。
//
// ============================================================================

import * as Sentry from '@sentry/react';
import { scrubEvent, type ScrubbableEvent } from '@shared/observability/scrubEvent';

let initialized = false;
let enabled = true;

export function setCrashReportingEnabled(value: boolean): void {
  enabled = value;
}

/** 初始化 renderer 侧 Sentry。应在 React 渲染前调用。无 DSN 时 no-op。 */
export function initSentryRenderer(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) {
    console.info('[Sentry] renderer disabled: no VITE_SENTRY_DSN');
    return;
  }

  Sentry.init({
    dsn,
    release: import.meta.env.VITE_APP_VERSION as string | undefined,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (!enabled) return null;
      scrubEvent(event as unknown as ScrubbableEvent);
      return event;
    },
  });

  initialized = true;
  console.info('[Sentry] renderer initialized');
}

export interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export function setSentryRendererContext(context: {
  sessionId?: string | null;
  userId?: string | null;
}): void {
  if (!initialized) return;
  Sentry.setTag('sessionId', context.sessionId ?? 'none');
  Sentry.setTag('userId', context.userId ?? 'anonymous');
}

/** 上报一个异常。未初始化 / 已 opt-out 时是 no-op。 */
export function captureRendererException(error: unknown, context?: CaptureContext): void {
  if (!initialized || !enabled) return;
  Sentry.captureException(error, context ? { tags: context.tags, extra: context.extra } : undefined);
}
