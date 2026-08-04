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
type ComposerInProgressId = 'voice' | 'upload';

const COMPOSER_IN_PROGRESS_PRIORITY: readonly ComposerInProgressId[] = [
  'voice',
  'upload',
];

// ============================================================================
// 槽位容器化：那一格的全部占用者按性质分四层
// ============================================================================
// 层级只在 COMPOSER_SLOT_LAYER 登记一次，新占用者不加这一行就进不了那一格
// （ComposerSlot 直接抛错拒渲染）。四层语义：
//   L1 阻塞决策：三张草稿确认卡 + 定时/目标/种子三张对话式创建卡。永不让位，同时来就摞。
//   L2 进行中：通话 / 上传。互斥，只留 COMPOSER_IN_PROGRESS_PRIORITY 里最靠前的那个。
//   L3 上下文：成员条 / 循环状态条 / 排队引导卡。不让位；被 L1 挤时可收成摘要（成员条已实现）。
//   L4 建议：建议条 / 能力建议 / 组合技能卡 / Plan 入口。L1 或 L2 有货就整层隐藏。
// 优先级判断不许写进任何一个占用者组件里——组件只声明「我是谁、我现在要不要出现」。
// ============================================================================

type ComposerSlotLayer = 1 | 2 | 3 | 4;

/** 那一格全部已登记的占用者。新占用者必须在 COMPOSER_SLOT_LAYER 加一行，否则拒渲染。 */
export type ComposerSlotOccupantId =
  | ComposerNoticeId
  | ComposerInProgressId
  | 'schedule-composer'
  | 'goal-confirm'
  | 'seed-composer'
  | 'member-bar'
  | 'loop-status'
  | 'queued-runtime-input'
  | 'suggestion-bar'
  | 'capability-strip'
  | 'combo-skill'
  | 'plan-entry';

export const COMPOSER_SLOT_LAYER: Readonly<Record<ComposerSlotOccupantId, ComposerSlotLayer>> = {
  'skill-draft': 1,
  'role-draft': 1,
  'team-recipe-draft': 1,
  'schedule-composer': 1,
  'goal-confirm': 1,
  'seed-composer': 1,
  voice: 2,
  upload: 2,
  'member-bar': 3,
  'loop-status': 3,
  'queued-runtime-input': 3,
  'suggestion-bar': 4,
  'capability-strip': 4,
  'combo-skill': 4,
  'plan-entry': 4,
};

interface ComposerNoticeState {
  notices: Record<string, boolean>;
  inProgress: Partial<Record<ComposerInProgressId, boolean>>;
  /** notices / inProgress 两张专属表之外的占用者，活跃态统一记在这里 */
  slotActive: Partial<Record<ComposerSlotOccupantId, boolean>>;
  setNotice: (id: ComposerNoticeId, active: boolean) => void;
  setInProgress: (id: ComposerInProgressId, active: boolean) => void;
  setSlotActive: (id: ComposerSlotOccupantId, active: boolean) => void;
}

export const useComposerNoticeStore = create<ComposerNoticeState>()((set) => ({
  notices: {},
  inProgress: {},
  slotActive: {},
  setNotice: (id, active) =>
    set((state) => (state.notices[id] === active ? state : { notices: { ...state.notices, [id]: active } })),
  setInProgress: (id, active) =>
    set((state) => (
      state.inProgress[id] === active
        ? state
        : { inProgress: { ...state.inProgress, [id]: active } }
    )),
  setSlotActive: (id, active) =>
    set((state) => (
      state.slotActive[id] === active
        ? state
        : { slotActive: { ...state.slotActive, [id]: active } }
    )),
}));

/** 任一占用者的活跃态：三张表的一处真源读取。
    用 OR 而不是 ??——显式写 false 的 id 不许把另一张表里的 true 遮掉。 */
const selectOccupantActive = (
  state: ComposerNoticeState,
  id: ComposerSlotOccupantId,
): boolean =>
  Boolean(state.slotActive[id])
  || Boolean(state.notices[id])
  || Boolean(state.inProgress[id as ComposerInProgressId]);

const selectLayerHasActive = (state: ComposerNoticeState, layer: ComposerSlotLayer): boolean =>
  (Object.keys(COMPOSER_SLOT_LAYER) as ComposerSlotOccupantId[])
    .some((id) => COMPOSER_SLOT_LAYER[id] === layer && selectOccupantActive(state, id));

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

/** L4 让位：建议层在 L1（要决策）或 L2（正在跑）有货时整层不出现。
    刻意不含 L3——L3 的成员条在整个多智能体会话里全程活跃，把它算进来等于
    「多人会话永远看不到能力建议」，那是杀功能不是让位。 */
export const selectSlotSuppressed = (
  state: ComposerNoticeState,
  id: ComposerSlotOccupantId,
): boolean =>
  COMPOSER_SLOT_LAYER[id] === 4
  && (selectLayerHasActive(state, 1) || selectLayerHasActive(state, 2));

/**
 * 槽位可见性的唯一判定处（返回原始布尔，安全用于 zustand selector）：
 * L1/L3 活跃即见；L2 只留互斥表头名；L4 见 selectSlotSuppressed。
 */
export const selectSlotVisible = (
  state: ComposerNoticeState,
  id: ComposerSlotOccupantId,
): boolean => {
  if (!selectOccupantActive(state, id)) return false;
  if (COMPOSER_SLOT_LAYER[id] === 2) {
    return selectIsCurrentComposerInProgress(state, id as ComposerInProgressId);
  }
  return !selectSlotSuppressed(state, id);
};

/** L3 专用：被 L1 挤时收成一行极窄摘要，而不是整条消失。
    不要求占用者先登记活跃——L3 组件自己知道有没有内容，这里只回答「现在挤不挤」。 */
export const selectSlotCollapsed = (
  state: ComposerNoticeState,
  id: ComposerSlotOccupantId,
): boolean =>
  COMPOSER_SLOT_LAYER[id] === 3 && selectLayerHasActive(state, 1);

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

/**
 * 通用占用者登记（notices / inProgress 两张专属表之外的所有人走这里）。
 * 组件只报「我现在要不要出现」，能不能出现由 selectSlotVisible 统一算。
 * enabled=false 用于「活跃态由组件自己登记」的占用者：此时 SlotEntry 不得代登记，
 * 否则卸载清理会把 occupant 自己写进去的那条抹掉。
 */
export function useRegisterComposerSlotOccupant(
  id: ComposerSlotOccupantId,
  active: boolean,
  enabled = true,
): void {
  const setSlotActive = useComposerNoticeStore((state) => state.setSlotActive);

  useEffect(() => {
    if (!enabled) return;
    setSlotActive(id, active);
    return () => setSlotActive(id, false);
  }, [active, id, enabled, setSlotActive]);
}
