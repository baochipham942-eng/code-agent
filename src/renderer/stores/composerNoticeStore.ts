// ============================================================================
// Composer Notice Store - 输入框上方那一格的占用登记
// ============================================================================
// 那一格同时被好几个东西惦记：三种草稿确认卡、成员条、后续可能还有别的。
// 确认卡是**阻塞性决策**（不确认就没法往下走），优先级最高；成员条是状态展示，
// 被挤掉时收成一行极窄摘要，而不是整条消失。
//
// 为什么要显式登记：WorkBuddy 的 `!dependencyGateNode && teamSlot` 就是把成员条
// 整条吞掉且不给任何提示，用户看不到成员也不知道为什么（2026-07-23 扒源码实证）。
// 这里让占用关系变成可读的一处真源，而不是散在各组件的隐式互斥。
// ============================================================================

import { create } from 'zustand';

/** 阻塞性通知的来源 id（新增占用者在这里登记，别在组件里各判各的） */
type ComposerNoticeId = 'skill-draft' | 'role-draft' | 'team-recipe-draft';

interface ComposerNoticeState {
  notices: Record<string, boolean>;
  setNotice: (id: ComposerNoticeId, active: boolean) => void;
}

export const useComposerNoticeStore = create<ComposerNoticeState>()((set) => ({
  notices: {},
  setNotice: (id, active) =>
    set((state) => (state.notices[id] === active ? state : { notices: { ...state.notices, [id]: active } })),
}));

/** selector：是否有阻塞性确认卡占着那一格（返回原始布尔，安全用于 zustand selector） */
export const selectHasBlockingNotice = (state: ComposerNoticeState): boolean =>
  Object.values(state.notices).some(Boolean);
