// ============================================================================
// Member View Store - 正在查看哪位团队成员
// ============================================================================
// 纯视图态：有值时聊天区渲染这位成员的对话，输入框被「回主会话」覆盖层挡住
// （人只跟团长说话，不跟成员说话）。换会话由 SessionMemberBar 就地清空。
// 独立成 store 而不是塞进 appStore：那边已经顶到 max-lines，且这是一个自洽的小关注点。
// ============================================================================

import { create } from 'zustand';

interface MemberViewState {
  viewingMemberId: string | null;
  setViewingMemberId: (memberId: string | null) => void;
}

export const useMemberViewStore = create<MemberViewState>()((set) => ({
  viewingMemberId: null,
  setViewingMemberId: (memberId) => set({ viewingMemberId: memberId }),
}));
