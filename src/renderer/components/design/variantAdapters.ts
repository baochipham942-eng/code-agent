// canvas 节点树 / proto HTML 版本 → 统一 Variant 抽象的适配层（纯函数，可单测）。
// canvas 仍以 canvas.json 节点树为真理源；proto 以 spine.json 持有 pin/discard。
// 适配器只做形态映射，不持有状态。
import type { Variant } from './variantSpine';
import type { CanvasImageNode } from './designCanvasTypes';

/** 画布图节点 → canvas-image variant。pinned 跟随 chosen，op 由是否有 parentId 推断。 */
export function canvasNodeToVariant(node: CanvasImageNode): Variant {
  const v: Variant = {
    id: node.id,
    kind: 'canvas-image',
    pinned: node.chosen === true,
    discarded: node.discarded === true,
    createdAt: node.createdAt,
    op: node.parentId ? 'edit' : 'generate',
    payload: {
      src: node.src,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    },
  };
  if (node.parentId) v.parentId = node.parentId;
  // 展示标题优先用户命名（T2 命名步），回退到生成/编辑指令。
  const label = node.label ?? node.prompt;
  if (typeof label === 'string') v.label = label;
  return v;
}

/**
 * proto 同一 run 下所有版本归入一个版本槽（共享 groupKey）：以 run 目录派生槽锚点，
 * 这样「设主版」在一个 run 内单选、跨 run 互不影响。
 */
export function protoGroupId(runDir: string): string {
  return `proto:${runDir.replace(/\/+$/, '')}`;
}

/**
 * 构造一个 proto-html variant（未 pinned；交给 appendVariant 决定 pinned）。
 * id 用版本快照绝对路径（唯一）；归入 run 槽。
 */
export function makeProtoVariant(
  htmlPath: string,
  createdAt: number,
  runDir: string,
  meta?: { op?: string; label?: string },
): Variant {
  const v: Variant = {
    id: htmlPath,
    kind: 'proto-html',
    parentId: protoGroupId(runDir),
    pinned: false,
    discarded: false,
    createdAt,
    payload: { htmlPath },
  };
  if (meta?.op) v.op = meta.op;
  if (meta?.label) v.label = meta.label;
  return v;
}
