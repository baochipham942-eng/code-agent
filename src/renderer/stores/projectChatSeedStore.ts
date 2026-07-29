import { create } from 'zustand';

// 项目协作空间底部输入框 → ChatView 的首条消息接力（轻量版 goal seed，无 run 语义）。
// 独立小 store：跨页面小状态不挂 appStore（god-file 门 + 共享小状态别挂大模块的房规）。

interface PendingProjectChatSeed {
  sessionId: string;
  content: string;
}

interface ProjectChatSeedState {
  pendingProjectChatSeed: PendingProjectChatSeed | null;
  setPendingProjectChatSeed: (seed: PendingProjectChatSeed | null) => void;
}

export const useProjectChatSeedStore = create<ProjectChatSeedState>((set) => ({
  pendingProjectChatSeed: null,
  setPendingProjectChatSeed: (seed) => set({ pendingProjectChatSeed: seed }),
}));
