/** 短 token（如「ha」）可能被模型连发；整段长正文相等才当成重放。 */
const REPLAY_EXACT_MIN_LENGTH = 32;

/**
 * 流式增量相对已落账正文还剩多少。重连/重放会把已经 flush 过的**整段**再送一遍。
 *
 * 🔴 只认「整段一模一样」，不做前缀裁剪：这条链路上 incoming 是**纯追加**的增量
 * （accumulator 只把 delta.content 拼起来，累计快照走的是 streamSnapshot 另一条路），
 * 而「前缀相同」区分不了「重放」和「合法的重复文本」——同一条消息依次收到合法增量
 * 'ha'、'haha' 时，前缀裁剪会把第二段砍成 'ha'，最终显示 'haha' 而不是 'hahaha'，
 * 正常流式正文丢字（ai-review #1696）。
 *
 * 本单（同段回答重复渲染两遍）的真正守卫在 sessionSnapshotMerge 的 findLiveCounterpart，
 * 不靠这条前缀启发式——去掉它之后重连回放的回归断言仍然全绿（实测，不是推断）。
 */
export function remainingAssistantStreamDelta(existing: string, incoming: string): string {
  if (!incoming) return '';
  if (!existing) return incoming;
  if (incoming === existing) {
    return incoming.length >= REPLAY_EXACT_MIN_LENGTH ? '' : incoming;
  }
  return incoming;
}
