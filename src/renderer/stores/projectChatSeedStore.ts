import { create } from 'zustand';
import type { ConversationEnvelope } from '@shared/contract/conversationEnvelope';

// 项目协作空间底部输入框 → ChatView 的首条消息接力（轻量版 goal seed，无 run 语义）。
// 独立小 store：跨页面小状态不挂 appStore（god-file 门 + 共享小状态别挂大模块的房规）。
// seed 带完整 envelope（附件/context/agent 选择等都在），不只是 content；
// envelope.clientMessageId 与 composer 乐观上屏的用户消息同 id——sendMessage 按 id 去重，
// 发送失败时 ChatView 也按它回滚乐观消息。

interface PendingProjectChatSeed {
  sessionId: string;
  envelope: ConversationEnvelope;
}

interface ProjectChatSeedState {
  pendingProjectChatSeed: PendingProjectChatSeed | null;
  setPendingProjectChatSeed: (seed: PendingProjectChatSeed | null) => void;
}

export const useProjectChatSeedStore = create<ProjectChatSeedState>((set) => ({
  pendingProjectChatSeed: null,
  setPendingProjectChatSeed: (seed) => set({ pendingProjectChatSeed: seed }),
}));
