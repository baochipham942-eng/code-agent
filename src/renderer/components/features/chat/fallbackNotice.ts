import type { Message } from '@shared/contract/message';
import { generateMessageId } from '@shared/utils/id';

export interface ModelFallbackNoticePayload {
  reason: string;
  from: string;
  to: string;
}

interface ModelFallbackNoticeEnvelope {
  __modelFallbackNotice: ModelFallbackNoticePayload;
}

export function encodeModelFallbackNotice(payload: ModelFallbackNoticePayload): string {
  return JSON.stringify({ __modelFallbackNotice: payload } satisfies ModelFallbackNoticeEnvelope);
}

export function isModelFallbackNoticeContent(content: string): boolean {
  return typeof content === 'string' && content.includes('"__modelFallbackNotice"');
}

export function parseModelFallbackNotice(content: string): ModelFallbackNoticePayload | null {
  try {
    const parsed = JSON.parse(content) as Partial<ModelFallbackNoticeEnvelope>;
    const notice = parsed?.__modelFallbackNotice;
    if (
      notice
      && typeof notice.reason === 'string'
      && typeof notice.from === 'string'
      && typeof notice.to === 'string'
    ) {
      return notice;
    }
  } catch {
    /* 非 JSON / 格式不符 */
  }
  return null;
}

export function buildModelFallbackNoticeMessage(payload: ModelFallbackNoticePayload): Message {
  return {
    id: generateMessageId(),
    role: 'system',
    source: 'model',
    content: encodeModelFallbackNotice(payload),
    timestamp: Date.now(),
  };
}
