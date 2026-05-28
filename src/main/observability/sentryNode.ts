// ============================================================================
// Sentry (Node) - backend / webServer 进程的崩溃与未捕获错误上报
// ============================================================================
//
// DSN 从 SENTRY_DSN 环境变量读取（打包态由 ~/.code-agent/.env 注入，缺省则禁用 = no-op）。
// DSN 是 write-only 公开值，可安全嵌入分发包，不是 secret。
// 只做错误监控（tracesSampleRate=0），不开 performance。
// beforeSend 复用 shared/scrubEvent 脱敏：崩溃报告永不含源码 / prompt / 密钥 / 家目录。
//
// ============================================================================

import os from 'os';
import * as Sentry from '@sentry/node';
import { createLogger } from '../services/infra/logger';
import { scrubEvent, type ScrubbableEvent } from '../../shared/observability/scrubEvent';

const logger = createLogger('SentryNode');

let initialized = false;
let enabled = true; // 运行时开关，配置层（crashReporting.enabled）可调

/** 配置层在设置加载/变更时调用，实现用户 opt-out（不影响已 init 的 SDK，只在 beforeSend 拦截） */
export function setCrashReportingEnabled(value: boolean): void {
  enabled = value;
}

/**
 * 初始化 Node 侧 Sentry。应在进程入口尽早调用（main/index.ts、web/webServer.ts）。
 * 无 DSN 时直接返回，不报错。
 */
export function initSentryNode(): void {
  if (initialized) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry(node) disabled: no SENTRY_DSN');
    return;
  }

  const homeDir = os.homedir();

  Sentry.init({
    dsn,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0,
    beforeSend(event) {
      if (!enabled) return null;
      scrubEvent(event as unknown as ScrubbableEvent, { homeDir });
      return event;
    },
  });

  initialized = true;
  logger.info('Sentry(node) initialized');
}

export interface CaptureContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/** 上报一个异常。未初始化 / 已 opt-out 时是 no-op。 */
export function captureException(error: unknown, context?: CaptureContext): void {
  if (!initialized || !enabled) return;
  Sentry.captureException(error, context ? { tags: context.tags, extra: context.extra } : undefined);
}

/** 上报一条消息（用于"上次会话异常退出"这类无 Error 对象的事件）。未初始化 / opt-out 时 no-op。 */
export function captureMessage(
  message: string,
  level: 'error' | 'warning' | 'info' = 'error',
  context?: CaptureContext,
): void {
  if (!initialized || !enabled) return;
  Sentry.captureMessage(message, { level, tags: context?.tags, extra: context?.extra });
}
