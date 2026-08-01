// 「调整大小」比例换算：目标宽高比 → 复用已有扩图(expand)能力的调用计划。
// 只扩不裁：任何一步都只往外加像素，从不裁剪/拉伸原图内容。

import type { ExpandDirection } from './useDesignCanvasGeneration';

/** 五档预设目标宽高比（宽/高）。 */
export const RESIZE_RATIO_PRESETS = {
  '1:1': 1,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
} as const;

export type ResizeRatioPresetId = keyof typeof RESIZE_RATIO_PRESETS;

/**
 * expand() 单边外扩倍数范围 [1,2]：与 useDesignCanvasGeneration.ts 里 ExpandArgs.ratio 的注释
 * 「扩展比例（1.0–2.0，单边外扩倍数）」及 host imageGenerationService.ts 的 clampExpandScale
 * 一致。renderer 不能 import host 模块，故本地镜像这两个边界值。
 */
const MIN_SCALE = 1;
const MAX_SCALE = 2;

/** 扩图管线的一步：与 ExpandArgs 的 direction/ratio 字段同构，调用方自行补 baseNode/prompt。 */
export interface ExpandStep {
  direction: ExpandDirection;
  ratio: number;
}

export type ResizePlan = { feasible: true; steps: ExpandStep[] } | { feasible: false; reason: string };

/**
 * 由「原图宽高 + 目标宽高比」算出调用 expand() 的步骤计划。
 *
 * 语义依据（读自 useDesignCanvasGeneration.ts 的 ExpandArgs 注释 + imageGenerationService.ts 的
 * WANX_EXPAND_SCALE_MIN=1.0 默认值/expandScalesForDirection 四向独立 scale）：ratio 是「单边外扩
 * 倍数」——某条边这一步新增的像素 = 该边当前边长 × (ratio-1)，ratio=1 即不扩（幂等），ratio=2 即
 * 该边一步最多外扩一个当前边长。'all' 四边同时按同一 ratio 外扩：W'=W(2r-1)、H'=H(2r-1)，比值不变，
 * 所以 'all' 改变不了宽高比，必须用单边方向（up/down/left/right）。
 *
 * 只扩不裁：本函数永远只增大「偏小」的那一个维度（宽或高），另一维度原样保留——即使裁剪能凑出目标
 * 比例也不做，做不到就直接判不可用（feasible:false + reason），不做拉伸/裁切的近似解。
 *
 * 为了让扩出来的内容居中（不是把原图整体推去一角），需要扩的那一维用两步对称扩展：比如要变宽，先
 * 'left' 扩掉一半差值，再在此基础上 'right' 扩另一半——而不是单边一次扩满整个差值。第二步的 ratio
 * 是相对「第一步扩完之后的当前边长」算的，因为 expand() 每次调用都拿上一步的结果图当新的 base 图。
 *
 * 不可用判据：两步中任一步所需 ratio 超出 [1,2] 就判不可用（expand() 的硬性范围；越界值会被
 * clampExpandScale 静默夹到边界而不是报错，所以必须在这里提前拦，不能让越界 ratio 混进结果）。
 * 由于等分两步时第一步（primary，向下取整余量给它）算出的 ratio 恒 ≥ 第二步，只判第一步即可，
 * 但两步都判更稳妥。
 */
export function computeResizeExpandPlan(width: number, height: number, targetRatio: number): ResizePlan {
  if (!(width > 0) || !(height > 0) || !(targetRatio > 0)) {
    return { feasible: false, reason: '原图宽高与目标比例须为正数' };
  }
  const currentRatio = width / height;

  let axis: 'width' | 'height';
  let targetDim: number; // 目标边长（扩完之后）
  let baseDim: number; // 原图对应边长
  if (targetRatio > currentRatio) {
    axis = 'width';
    baseDim = width;
    targetDim = Math.round(height * targetRatio);
  } else if (targetRatio < currentRatio) {
    axis = 'height';
    baseDim = height;
    targetDim = Math.round(width / targetRatio);
  } else {
    return { feasible: true, steps: [] }; // 已是目标比例，无需扩图
  }

  const delta = targetDim - baseDim;
  if (delta <= 0) {
    // 目标比例与当前比例的差距被取整精度（<0.5px）吃掉了，当无需扩图处理，
    // 别把「差一点点」误判成不可用（浮点/取整边界见函数头注释）。
    return { feasible: true, steps: [] };
  }

  const primary = Math.ceil(delta / 2);
  const secondary = delta - primary;
  const [dir1, dir2]: [ExpandDirection, ExpandDirection] = axis === 'width' ? ['left', 'right'] : ['up', 'down'];

  const ratio1 = 1 + primary / baseDim;
  const ratio2 = 1 + secondary / (baseDim + primary);

  if (ratio1 > MAX_SCALE || ratio2 > MAX_SCALE) {
    // 等分两步对称扩展下，单边理论上限 ≈ 3× 原边长（ratio1 触顶时 primary=baseDim，
    // delta=2*baseDim，targetDim=baseDim+delta=3*baseDim）。
    // reason 说人话（2026-08-01 工单③）：用户视角一句带过——什么形状变什么形状、要补多少、
    // 超没超能力。像素数字保留（有信息量），内部机制词（两步对称扩展/扩图能力上限）不出现。
    const factorRaw = targetDim / baseDim;
    const factor = factorRaw >= 10 ? String(Math.round(factorRaw)) : factorRaw.toFixed(1).replace(/\.0$/, '');
    return {
      feasible: false,
      reason:
        axis === 'width'
          ? `这张图太窄，变成横版需要把宽度从 ${baseDim}px 补到 ${targetDim}px（约 ${factor} 倍），超出能力`
          : `这张图太扁，变成竖版需要把高度从 ${baseDim}px 补到 ${targetDim}px（约 ${factor} 倍），超出能力`,
    };
  }

  return {
    feasible: true,
    steps: [
      { direction: dir1, ratio: Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio1)) },
      { direction: dir2, ratio: Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio2)) },
    ],
  };
}
