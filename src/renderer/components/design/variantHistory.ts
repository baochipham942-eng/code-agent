// variant spine 上的 undo/redo 纯逻辑（无 React 依赖，可单测）。
// T2 信任 UI：每个 op 落为同槽时间线上的一步，「回滚到前一 variant」= 把前一版设为主版。
// 非破坏式——回滚只移动「主版指针」，后续版本仍在槽内保留，可 redo（与 spine 槽内单主版语义一致）。
import {
  activeVariants,
  groupKey,
  pinnedInGroup,
  type Variant,
  type VariantSpine,
} from './variantSpine';

/** 同槽活跃 variant，按 createdAt 升序（最早→最新），即历史步进时间线。 */
export function slotTimeline(spine: VariantSpine, slotKey: string): Variant[] {
  return activeVariants(spine)
    .filter((v) => groupKey(v) === slotKey)
    // 同毫秒 createdAt 时以 id 作 tie-break，保证时间线顺序确定（undo/redo 步进可复现）。
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * 当前「主版」：槽内 pinned 的活跃版；若无显式 pinned，则默认最新活跃版（head）。
 * 这样未定稿的槽也有确定的「当前」用于 undo/redo 取参照。
 */
export function currentVariant(spine: VariantSpine, slotKey: string): Variant | undefined {
  const pinned = pinnedInGroup(spine, slotKey);
  if (pinned) return pinned;
  const tl = slotTimeline(spine, slotKey);
  return tl.length > 0 ? tl[tl.length - 1] : undefined;
}

function currentIndex(spine: VariantSpine, slotKey: string): number {
  const tl = slotTimeline(spine, slotKey);
  const cur = currentVariant(spine, slotKey);
  if (!cur) return -1;
  return tl.findIndex((v) => v.id === cur.id);
}

/** 回滚目标：时间线上当前版的前一版 id（undo target），已是最早版则 undefined。 */
export function previousVariantId(spine: VariantSpine, slotKey: string): string | undefined {
  const tl = slotTimeline(spine, slotKey);
  const idx = currentIndex(spine, slotKey);
  return idx > 0 ? tl[idx - 1].id : undefined;
}

/** 重做目标：时间线上当前版的后一版 id（redo target），已是最新版则 undefined。 */
export function nextVariantId(spine: VariantSpine, slotKey: string): string | undefined {
  const tl = slotTimeline(spine, slotKey);
  const idx = currentIndex(spine, slotKey);
  return idx >= 0 && idx < tl.length - 1 ? tl[idx + 1].id : undefined;
}

export function canUndo(spine: VariantSpine, slotKey: string): boolean {
  return previousVariantId(spine, slotKey) !== undefined;
}

export function canRedo(spine: VariantSpine, slotKey: string): boolean {
  return nextVariantId(spine, slotKey) !== undefined;
}
