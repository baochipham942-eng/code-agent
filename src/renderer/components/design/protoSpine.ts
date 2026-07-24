// proto 侧 variant spine 落盘 + 与磁盘版本快照对账。
// 真理源分工：versions/v-*.html = 快照存在性（append-only，已非破坏性）；
// spine.json = 各版本的 pin/discard 状态。两者经 reconcile 合并成一份 VariantSpine。
import { DESIGN_SPINE_FILE } from '@shared/constants';
import {
  activeVariants,
  pinnedInGroup,
  pinVariant,
  type VariantSpine,
} from './variantSpine';
import { makeProtoVariant, protoGroupId } from './variantAdapters';
import type { DesignVersion } from './designFiles';

export function protoSpinePath(runDir: string): string {
  return `${runDir.replace(/\/+$/, '')}/${DESIGN_SPINE_FILE}`;
}

/**
 * 与磁盘版本对账（纯函数）：把 spine 里还没有的版本补成活跃 variant，
 * 保留既有 variant 的 pin/discard（已淘汰的不复活、用户的 pin 不被改写）；
 * 仅当整组没有任何活跃 pinned 时，自动把最新活跃版升为主版（兜底定稿）。
 */
export function reconcileProtoSpine(
  spine: VariantSpine,
  versions: DesignVersion[],
  runDir: string,
): VariantSpine {
  const known = new Set(spine.variants.map((v) => v.id));
  const added = versions
    .filter((v) => !known.has(v.path))
    .map((v) => makeProtoVariant(v.path, v.createdAt, runDir));
  let next: VariantSpine = { ...spine, variants: [...spine.variants, ...added] };

  const key = protoGroupId(runDir);
  if (!pinnedInGroup(next, key)) {
    const latest = activeVariants(next)
      .filter((v) => v.parentId === key)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) next = pinVariant(next, latest.id);
  }
  return next;
}
