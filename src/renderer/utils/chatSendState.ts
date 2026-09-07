import type { SteerOrQueueOutcome } from '@shared/contract/appService';

/**
 * renderer 发送链路的交付结果。queued/steered 沿用 host 契约；
 * sent/failed 补上原先「成功和失败都 return undefined」的空洞。
 */
export type ChatSendDelivery =
  | SteerOrQueueOutcome
  | { outcome: 'sent' }
  | { outcome: 'failed' };

const inflightSends = new Map<string, Promise<ChatSendDelivery>>();

export function chatSendInflightKey(sessionId: string, clientMessageId: string): string {
  return `${sessionId}:${clientMessageId}`;
}

/**
 * 同一 session + clientMessageId 在途只跑一次。第二次调用共用同一个 Promise，
 * 不二次乐观上屏、不二次打 host。settle 后立即释放，失败允许用同一键重试。
 */
export function claimSendInflight(
  key: string,
  start: () => Promise<ChatSendDelivery>,
): Promise<ChatSendDelivery> {
  const existing = inflightSends.get(key);
  if (existing) return existing;
  const promise = start().finally(() => {
    if (inflightSends.get(key) === promise) inflightSends.delete(key);
  });
  inflightSends.set(key, promise);
  return promise;
}

export function isChatSendAccepted(delivery: ChatSendDelivery | undefined): boolean {
  return delivery != null && delivery.outcome !== 'failed';
}

/**
 * composer 发出时的 clientMessageId：envelope 已带的优先（错误卡重试会铸进去），
 * 否则消费「编辑重发」留下的 pending id，再否则新铸。
 * pending 必须在这次发送里用掉，避免下一条无关消息误复用失败气泡的 id。
 */
export function consumePendingClientMessageId(
  envelopeClientMessageId: string | undefined,
  pending: { current: string | null },
  generateId: () => string,
): string {
  const clientMessageId = envelopeClientMessageId ?? pending.current ?? generateId();
  pending.current = null;
  return clientMessageId;
}
