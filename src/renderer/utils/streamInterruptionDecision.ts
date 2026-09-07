import type { Message, StreamRecoverySnapshot } from '@shared/contract';
import { deriveStreamInterruptionReason } from './streamInterruptionPresentation';

/**
 * 中断决策槽只在流真正断掉时出现。
 * AGENT_STREAM_SNAPSHOT_REQUIRED 会在活 run 中途把 incomplete snapshot 灌回
 * sessionStore；那是续接证据，不是「上次回复已中断」。活轮还在出 token 时
 * 再亮 DecisionSlot，Continue 会把同一句再交一次。
 */
export function deriveStreamInterruptionDecision(
  streamSnapshot: StreamRecoverySnapshot | null,
  retryMessage: Message | null,
  isLiveTurn: boolean,
  messages: Message[] = [],
): { snapshot: StreamRecoverySnapshot; retryMessage: Message } | null {
  if (isLiveTurn) return null;
  if (!streamSnapshot || !retryMessage) return null;
  return {
    snapshot: {
      ...streamSnapshot,
      interruptionReason: streamSnapshot.interruptionReason
        ?? deriveStreamInterruptionReason(messages, streamSnapshot.turnId),
    },
    retryMessage,
  };
}
