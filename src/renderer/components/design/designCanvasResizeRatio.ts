// 「调整大小」比例换算：目标宽高比 → 复用已有扩图(expand)能力的调用参数。
// 只扩不裁：只往外加像素，从不裁剪/拉伸原图内容。

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
 * expand() 单边 scale 范围 [1,2]：与 host imageGenerationService.ts 的 clampExpandScale
 * （WANX_EXPAND_SCALE_MIN/MAX）及 workspaceDesignMedia.ipc.ts 的入参校验同界。
 * renderer 不能 import host 模块，故本地镜像这两个边界值。
 */
const MIN_SCALE = 1;
const MAX_SCALE = 2;

/** 四向单边 scale，与 host ExpandScales 同构；调用方自行补 baseNode/prompt。 */
export interface ResizeScales {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** scales 为 null = 已是目标比例，无需扩图（也就不该发生付费调用）。 */
export type ResizePlan = { feasible: true; scales: ResizeScales | null } | { feasible: false; reason: string };

/**
 * 由「原图宽高 + 目标宽高比」算出**一次** expand() 调用的四向 scale。
 *
 * 语义依据（host imageGenerationService.expandImage → wanx `*_scale` 参数）：每条边的 scale 是
 * **相对原图对应边长**的外扩倍数——该边新增像素 = 原边长 × (scale-1)，scale=1 即该边不扩。
 * 所以一次调用后：
 *
 *   W' = W × (leftScale + rightScale − 1)      H' = H × (topScale + bottomScale − 1)
 *
 * 需要扩的那一维**左右（或上下）对称等分**，让新内容长在两侧、原图仍居中；另一维两边都保持 1。
 * 由 W' = targetW 且 left = right 解得 left = right = (1 + targetW/W) / 2。
 *
 * 只扩不裁：永远只增大「偏小」的那一个维度（宽或高），另一维度原样保留——即使裁剪能凑出目标比例
 * 也不做，做不到就直接判不可用（feasible:false + reason），不做拉伸/裁切的近似解。
 *
 * 不可用判据：所需单边 scale 超出 [1,2]（expand() 的硬性范围；越界值会被 clampExpandScale 静默夹到
 * 边界而不是报错，所以必须在这里提前拦，不能让越界值混进结果变成「扩了个寂寞」的付费调用）。
 * 对称等分下 scale ≤ 2 等价于 targetDim ≤ 3 × 原边长——与旧的两步实现上限一致，改法不缩可行范围。
 *
 * 2026-08-01：本函数原先返回两个 step（= 两次付费扩图），因为当时 IPC 一次只收单个 direction+ratio。
 * IPC 支持四向独立 scale 后降到一次——省一半钱，且不再「在第一步的生成结果上再生成」（避免二次劣化）。
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
    return { feasible: true, scales: null }; // 已是目标比例，无需扩图
  }

  if (targetDim - baseDim <= 0) {
    // 目标比例与当前比例的差距被取整精度（<0.5px）吃掉了，当无需扩图处理，
    // 别把「差一点点」误判成不可用（浮点/取整边界见函数头注释）。
    return { feasible: true, scales: null };
  }

  // 对称等分：两侧各承担一半外扩量。
  const scale = (1 + targetDim / baseDim) / 2;

  if (scale > MAX_SCALE) {
    // reason 说人话（2026-08-01 工单③）：用户视角一句带过——什么形状变什么形状、要补多少、
    // 超没超能力。像素数字保留（有信息量），内部机制词（对称扩展/扩图能力上限）不出现。
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

  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  return {
    feasible: true,
    scales:
      axis === 'width'
        ? { top: MIN_SCALE, bottom: MIN_SCALE, left: s, right: s }
        : { top: s, bottom: s, left: MIN_SCALE, right: MIN_SCALE },
  };
}
