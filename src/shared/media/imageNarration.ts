// 出图复述/验收句的语言无关内核：比例数学 + 尺寸预期。
//
// 只放「能被数字证伪」的部分，不放任何文案——文案由各端自己拼（host 侧直出中文工具输出，
// renderer 侧走 i18n）。这样两端共用同一套判定，不会出现「一端说相符、另一端说不符」。

/** 比例字符串 → 宽高比数值。未知比例返回 undefined（调用方据此不输出比例断言）。 */
export function aspectRatioValue(ratio: string): number | undefined {
  const match = /^(\d+):(\d+)$/.exec(ratio.trim());
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return undefined;
  return w / h;
}

/** 画面朝向；文案词（竖版/横版/方形）由各端按自己的语言给。 */
export type AspectOrientation = 'portrait' | 'landscape' | 'square';

export function aspectOrientation(ratio: string): AspectOrientation | undefined {
  const value = aspectRatioValue(ratio);
  if (value === undefined) return undefined;
  if (Math.abs(value - 1) < 1e-6) return 'square';
  return value > 1 ? 'landscape' : 'portrait';
}

/**
 * 各引擎对同一比例给的像素档并不相同（9:16 实测有 720×1280 / 768×1344 / 1024×1792 三档，
 * 彼此差 1.6%），所以「相符」必须留容差；5% 能容下这些档位差，又能一眼判死
 * 「要 9:16 却给了 1:1」（差 78%）这类真跑偏。
 */
const ASPECT_RATIO_TOLERANCE = 0.05;

/** 实际像素是否符合请求的比例。任一输入不可解析时返回 undefined = 「说不出结论」。 */
export function aspectRatioMatches(
  width: number,
  height: number,
  ratio: string,
  tolerance: number = ASPECT_RATIO_TOLERANCE,
): boolean | undefined {
  const expected = aspectRatioValue(ratio);
  if (expected === undefined || !(width > 0) || !(height > 0)) return undefined;
  return Math.abs(width / height - expected) / expected <= tolerance;
}

/** 扩图方向，与 main 侧 imageGenerationService / 画布 hook 同义。 */
export type ExpandDirection = 'up' | 'down' | 'left' | 'right' | 'all';

/** 四向单边外扩倍数，与 host ExpandScales / renderer ResizeScales 同构。 */
export interface ExpandScales {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * 扩图后的预期像素。单边 scale 的语义（host imageGenerationService 的 wanx `*_scale`）是
 * **相对原图对应边长**的外扩倍数：该边新增像素 = 原边长 × (scale−1)，scale=1 即不扩。故
 *
 *   W' = W × (left + right − 1)      H' = H × (top + bottom − 1)
 *
 * 与 designCanvasResizeRatio.computeResizeExpandPlan 反解时用的是同一条式子——两处必须同源，
 * 否则「按目标比例算出的 scale」和「按 scale 算出的预期尺寸」会各说各话，验收句就成了噪声。
 */
export function expectedExpandSizeFromScales(
  width: number,
  height: number,
  scales: ExpandScales,
): { width: number; height: number } | undefined {
  const { top, bottom, left, right } = scales;
  if (!(width > 0) || !(height > 0)) return undefined;
  if (![top, bottom, left, right].every((s) => s > 0)) return undefined;
  return {
    width: Math.round(width * (left + right - 1)),
    height: Math.round(height * (top + bottom - 1)),
  };
}

/**
 * 单方向扩图的预期像素：单向按该轴外扩 ratio 倍，'all' 四周各扩。
 * 只是把方向翻译成四向 scale 后走同一条式子——预期尺寸全仓只有一个算法。
 * 用于验收句拿预期和实际对数——预期算不出来就不出这句断言。
 */
export function expectedExpandSize(
  width: number,
  height: number,
  direction: ExpandDirection,
  ratio: number,
): { width: number; height: number } | undefined {
  if (!(ratio > 0)) return undefined;
  const one = { top: 1, bottom: 1, left: 1, right: 1 };
  switch (direction) {
    case 'left': return expectedExpandSizeFromScales(width, height, { ...one, left: ratio });
    case 'right': return expectedExpandSizeFromScales(width, height, { ...one, right: ratio });
    case 'up': return expectedExpandSizeFromScales(width, height, { ...one, top: ratio });
    case 'down': return expectedExpandSizeFromScales(width, height, { ...one, bottom: ratio });
    case 'all':
      return expectedExpandSizeFromScales(width, height, { top: ratio, bottom: ratio, left: ratio, right: ratio });
    default:
      return undefined;
  }
}

/** 两组尺寸是否在容差内一致（扩图验收用，容 1px 取整误差 + 引擎对齐到 8/64 的倍数）。 */
export function sizeApproxEquals(
  actual: { width: number; height: number },
  expected: { width: number; height: number },
  tolerance: number = ASPECT_RATIO_TOLERANCE,
): boolean {
  if (!(expected.width > 0) || !(expected.height > 0)) return false;
  return (
    Math.abs(actual.width - expected.width) / expected.width <= tolerance &&
    Math.abs(actual.height - expected.height) / expected.height <= tolerance
  );
}

/**
 * PNG IHDR 取宽高。两条出图链路落盘的都是 PNG，这里只认 PNG——
 * 非 PNG 返回 undefined，调用方据此在验收句里省掉尺寸断言，而不是猜一个数。
 * ponytail: 只解 PNG；真出现 JPEG/WebP 再按需补，别为没发生的格式引 sharp。
 */
export function parsePngDimensions(buffer: Uint8Array): { width: number; height: number } | undefined {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24) return undefined;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buffer[i] !== PNG_SIGNATURE[i]) return undefined;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (!width || !height) return undefined;
  return { width, height };
}
