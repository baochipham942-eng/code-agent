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

import { useEffect } from 'react';
import { create } from 'zustand';

/** 阻塞性通知的来源 id（新增占用者在这里登记，别在组件里各判各的） */
type ComposerNoticeId = 'skill-draft' | 'role-draft' | 'team-recipe-draft';

/** 「进行中」占用者。优先级只能由下面这张表表达，组件不得互相探测。 */
type ComposerInProgressId = 'voice' | 'surface-execution' | 'upload';

const COMPOSER_IN_PROGRESS_PRIORITY: readonly ComposerInProgressId[] = [
  'voice',
  'surface-execution',
  'upload',
];

interface ComposerNoticeState {
  notices: Record<string, boolean>;
  inProgress: Partial<Record<ComposerInProgressId, boolean>>;
  setNotice: (id: ComposerNoticeId, active: boolean) => void;
  setInProgress: (id: ComposerInProgressId, active: boolean) => void;
}

export const useComposerNoticeStore = create<ComposerNoticeState>()((set) => ({
  notices: {},
  inProgress: {},
  setNotice: (id, active) =>
    set((state) => (state.notices[id] === active ? state : { notices: { ...state.notices, [id]: active } })),
  setInProgress: (id, active) =>
    set((state) => (
      state.inProgress[id] === active
        ? state
        : { inProgress: { ...state.inProgress, [id]: active } }
    )),
}));

/** selector：是否有阻塞性确认卡占着那一格（返回原始布尔，安全用于 zustand selector） */
export const selectHasBlockingNotice = (state: ComposerNoticeState): boolean =>
  Object.values(state.notices).some(Boolean);

/** 当前唯一允许显示的「进行中」占用者。顺序只在本文件定义一次。 */
const selectCurrentComposerInProgress = (
  state: ComposerNoticeState,
): ComposerInProgressId | null => (
  COMPOSER_IN_PROGRESS_PRIORITY.find((id) => state.inProgress[id]) ?? null
);

/** selector：指定占用者是否是当前最高优先级的「进行中」。 */
export const selectIsCurrentComposerInProgress = (
  state: ComposerNoticeState,
  id: ComposerInProgressId,
): boolean => selectCurrentComposerInProgress(state) === id;

/**
 * 占用者登记自己的显示意愿，并读取统一优先级结果。卸载时撤销登记，避免幽灵占位。
 */
export function useRegisterComposerInProgress(
  id: ComposerInProgressId,
  active: boolean,
): void {
  const setInProgress = useComposerNoticeStore((state) => state.setInProgress);

  useEffect(() => {
    setInProgress(id, active);
    return () => setInProgress(id, false);
  }, [active, id, setInProgress]);
}
