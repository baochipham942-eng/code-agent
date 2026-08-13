// ============================================================================
// Realtime 上游事件工具（从 realtimeTransport 拆出，god-file 债务门：effective>1000）
// 事件形状、response id 归一、原始帧解析、tools 回显判定、dev 故障注入接缝。
// ============================================================================

import { createLogger } from '../infra/logger';

const logger = createLogger('RealtimeVoice');

export interface UpstreamEvent {
  type: string;
  response_id?: string;
  item_id?: string;
  response?: { id?: string; usage?: unknown };
  item?: { id?: string };
  delta?: string;
  transcript?: string;
  audio?: string;
  error?: { code?: string; message?: string };
  [key: string]: unknown;
}

/**
 * 真机故障注入接缝（L7 看门狗 P3 / L10 剧本库哑火场景共用）：把 realtime 上游经本地
 * 拦截代理转发。双门控——只在 dev API 开启时认 override，生产/普通用户永远走真实上游；
 * 原 URL 的 query（model 等）由代理侧合并，这里只换 origin+path。
 */
export function resolveUpstreamUrlOverride(realUrl: string): string {
  if (process.env.CODE_AGENT_ENABLE_DEV_API !== 'true') return realUrl;
  const override = process.env.CODE_AGENT_VOICE_UPSTREAM_URL_OVERRIDE;
  if (!override) return realUrl;
  const query = realUrl.includes('?') ? realUrl.slice(realUrl.indexOf('?')) : '';
  logger.warn('voice upstream URL override active (dev only)', { override });
  return `${override}${query}`;
}

export function responseIdOf(event: UpstreamEvent, fallback = ''): string {
  if (typeof event.response_id === 'string' && event.response_id) return event.response_id;
  if (typeof event.response?.id === 'string' && event.response.id) return event.response.id;
  return fallback;
}

export function parseEvent(raw: unknown): UpstreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object' && typeof (parsed as UpstreamEvent).type === 'string') {
      return parsed as UpstreamEvent;
    }
  } catch {
    // 上游偶发非 JSON 帧，忽略即可；不要打印内容（可能含音频 base64）。
  }
  return null;
}

/** session.updated 回显里是否真收下了工具。回显不带 tools 字段一律按「没收下」算。 */
export function upstreamAcceptedTools(event: UpstreamEvent): boolean {
  const session = event.session as { tools?: unknown } | undefined;
  return Array.isArray(session?.tools) && session.tools.length > 0;
}
