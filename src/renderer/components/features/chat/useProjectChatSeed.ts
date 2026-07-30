// ============================================================================
// useProjectChatSeed —— 协作空间 composer seed 的消费端（ChatView 挂载）。
// composer 已建好新会话、乐观上屏首条用户消息（落地即在时间线上）并落 seed
// （完整 envelope，clientMessageId 与乐观消息同 id）；本 hook 在目标会话就绪后
// 把 envelope 真正发给 agent（sendMessage 按 id 去重不双份）。
// 发送失败回滚乐观消息——时间线上不许躺一条没发出去的话。
// ============================================================================

import { useEffect } from 'react';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';
import { useProjectChatSeedStore } from '../../../stores/projectChatSeedStore';
import { useSessionStore } from '../../../stores/sessionStore';

/** 发送失败时按 clientMessageId 移除 composer 乐观上屏的首条消息 */
export function rollbackProjectChatSeedMessage(clientMessageId?: string): void {
  if (!clientMessageId) return;
  const state = useSessionStore.getState();
  state.setMessages(state.messages.filter((message) => message.id !== clientMessageId));
}

export function useProjectChatSeedConsumption(params: {
  currentSessionId: string | null;
  effectiveIsProcessing: boolean;
  handleSendEnvelope: (envelope: ConversationEnvelope) => Promise<boolean>;
}): void {
  const { currentSessionId, effectiveIsProcessing, handleSendEnvelope } = params;
  const pendingProjectChatSeed = useProjectChatSeedStore((state) => state.pendingProjectChatSeed);
  useEffect(() => {
    if (!pendingProjectChatSeed || !currentSessionId || effectiveIsProcessing) return;
    if (pendingProjectChatSeed.sessionId !== currentSessionId) return;

    const seed = pendingProjectChatSeed;
    useProjectChatSeedStore.getState().setPendingProjectChatSeed(null);
    void handleSendEnvelope(seed.envelope).then((sent) => {
      if (!sent) rollbackProjectChatSeedMessage(seed.envelope.clientMessageId);
    }).catch(() => rollbackProjectChatSeedMessage(seed.envelope.clientMessageId));
  }, [pendingProjectChatSeed, currentSessionId, effectiveIsProcessing, handleSendEnvelope]);
}
