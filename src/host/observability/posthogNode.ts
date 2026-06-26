// ============================================================================
// PostHog (Node) — 产品行为分析（DAU/留存/事件流），与 Sentry/telemetry 解耦
// ============================================================================
//
// distinct_id 策略：登录后 setCurrentDistinctId(getPostHogDistinctId(userId))；
// 登出 setCurrentDistinctId(null)。永远不把 raw Supabase user id 发给 PostHog。
// 与 sentryNode 对称：无 POSTHOG_KEY 时全程 no-op；运行时 opt-out 走 setPostHogEnabled。
//
// ============================================================================

import { createHash } from 'crypto';
import { PostHog } from 'posthog-node';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PostHogNode');

let client: PostHog | null = null;
let enabled = true;
let currentDistinctId: string | null = null;

export function getPostHogDistinctId(userId: string): string {
  return `user_${createHash('sha256').update(`posthog:${userId}`).digest('hex').slice(0, 32)}`;
}

/** 初始化 PostHog Node 客户端。应在进程入口尽早调用。无 POSTHOG_KEY 时 no-op。 */
export function initPostHogNode(): void {
  if (client) return;
  const key = process.env.POSTHOG_KEY;
  if (!key) {
    logger.info('PostHog(node) disabled: no POSTHOG_KEY');
    return;
  }
  const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
  client = new PostHog(key, { host, flushAt: 5, flushInterval: 3000 });
  logger.info('PostHog(node) initialized');
}

export function setPostHogEnabled(value: boolean): void {
  enabled = value;
}

/** 设当前登录用户为 distinct_id；登出时传 null。 */
export function setCurrentDistinctId(id: string | null): void {
  currentDistinctId = id;
}

/** 上报一个事件。distinctId 可显式覆盖，否则用 setCurrentDistinctId 设的值，再否则匿名。 */
export function trackNode(
  event: string,
  properties?: Record<string, unknown>,
  distinctId?: string,
): void {
  if (!client || !enabled) return;
  try {
    client.capture({
      distinctId: distinctId ?? currentDistinctId ?? 'anonymous',
      event,
      properties,
    });
  } catch (err) {
    logger.warn('PostHog track failed', err);
  }
}

/** 关联 distinct_id 与用户属性（仅 metadata，禁止传邮箱/PII）。 */
export function identifyNode(distinctId: string, properties?: Record<string, unknown>): void {
  if (!client || !enabled) return;
  try {
    client.identify({ distinctId, properties });
  } catch (err) {
    logger.warn('PostHog identify failed', err);
  }
}

/** 关停 — 退出前 flush 剩余事件。 */
export async function shutdownPostHog(): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown();
  } catch (err) {
    logger.warn('PostHog shutdown failed', err);
  }
}
