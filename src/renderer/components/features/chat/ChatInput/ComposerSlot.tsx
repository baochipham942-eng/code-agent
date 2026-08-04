// ============================================================================
// ComposerSlot - 输入框上方那一格的统一渲染容器
// ============================================================================
// 那一格的占用者全部经由 <SlotEntry id> 挂载，容器只认登记过的 id：
//   - 直接子节点不是 SlotEntry，或 id 没进 COMPOSER_SLOT_LAYER → 抛错拒渲染。
//     「新占用者不接进来也不会报错」就是这么堵上的——不接 = 根本进不了那一格。
//   - 让不让位由 composerNoticeStore 的 selector 统一算，占用者组件里不许再写
//     `!isUploading && ...` 这类互相探测。
// 层级语义（L1 阻塞 / L2 进行中互斥 / L3 上下文 / L4 建议可隐藏）见 store。
// ============================================================================

import React from 'react';
import {
  COMPOSER_SLOT_LAYER,
  selectSlotSuppressed,
  selectSlotVisible,
  useComposerNoticeStore,
  useRegisterComposerSlotOccupant,
  type ComposerSlotOccupantId,
} from '../../../../stores/composerNoticeStore';

interface SlotEntryProps {
  /** 已登记的占用者 id（层级在 COMPOSER_SLOT_LAYER 查，不在这里传） */
  id: ComposerSlotOccupantId;
  /**
   * 挂载点已知的活跃条件。传了 = 由 SlotEntry 负责登记与显隐；
   * 不传 = 占用者自闸（活跃态写在它自己的 effect 里，见下方说明）。
   */
  active?: boolean;
  children: React.ReactNode;
}

export function SlotEntry({ id, active, children }: SlotEntryProps) {
  if (!(id in COMPOSER_SLOT_LAYER)) {
    throw new Error(
      `[ComposerSlot] 占用者 "${String(id)}" 未在 COMPOSER_SLOT_LAYER 登记层级，进不了输入框上方那一格`,
    );
  }
  const mountGated = active !== undefined;
  if (mountGated && COMPOSER_SLOT_LAYER[id] === 2) {
    // L2 的互斥表读的是 inProgress，挂载点写进 slotActive 不会被它看见——那样只会
    // 静默地永远不显示。宁可现在报错，也不留一个「登记了却看不见」的哑口。
    throw new Error(
      `[ComposerSlot] L2 进行中层占用者 "${String(id)}" 的活跃态必须走 useRegisterComposerInProgress（互斥表在那里），不能由挂载点传 active`,
    );
  }
  useRegisterComposerSlotOccupant(id, active ?? false, mountGated);
  const visible = useComposerNoticeStore((state) => selectSlotVisible(state, id));
  const suppressed = useComposerNoticeStore((state) => selectSlotSuppressed(state, id));

  if (mountGated) return visible ? <>{children}</> : null;
  // 自闸占用者（草稿卡 / 通话 / 上传 / 成员条 …）：它们把活跃态写在自己的 effect 里，
  // 不先挂上去就永远登记不了。所以这里**不能**按活跃态决定挂不挂——那是个死锁：
  // 没登记 → 不渲染 → 更没机会登记。容器对它们只做层级压制，「有没有内容」由组件自己判断
  // （这也正是今天的行为：每个占用者没内容时自己 return null）。
  return suppressed ? null : <>{children}</>;
}

/**
 * 统一容器：那一格只渲染 SlotEntry，其它任何东西（裸 div、未登记的组件）直接抛错。
 * 这道校验就是「防以后又有人往里塞一个不声明层级的」的门，配套测试见 composerSlotContainer.test.tsx。
 *
 * 用 display:contents（Tailwind `contents`）而不是普通 block：容器只是逻辑分组，
 * 不生成盒子，占用者仍然直接参与 form 的正常流——布局与外边距合并跟容器化之前逐像素一致。
 */
export function ComposerSlot({ children }: { children: React.ReactNode }) {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child) || child.type !== SlotEntry) {
      throw new Error(
        '[ComposerSlot] 输入框上方那一格只渲染 <SlotEntry id>：新占用者必须声明身份与层级，'
        + '层级登记在 composerNoticeStore 的 COMPOSER_SLOT_LAYER',
      );
    }
  });
  return <div data-testid="composer-slot" className="contents">{children}</div>;
}
