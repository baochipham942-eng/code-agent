/** 短 token（如「ha」）可能被模型连发；整段长正文相等才当成重放。 */
const REPLAY_EXACT_MIN_LENGTH = 32;

/**
 * 流式增量相对已落账正文还剩多少。
 * 重连/重放会把已经 flush 过的整段再送一遍；累计快照则只留下未读后缀。
 */
export function remainingAssistantStreamDelta(existing: string, incoming: string): string {
  if (!incoming) return '';
  if (!existing) return incoming;
  if (incoming === existing) {
    return incoming.length >= REPLAY_EXACT_MIN_LENGTH ? '' : incoming;
  }
  if (incoming.startsWith(existing)) return incoming.slice(existing.length);
  return incoming;
}
