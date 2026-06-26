// T4 一致性锁定再编辑：局部重绘(inpaint)后校验「未选区域逐像素不变（或感知 ε 内）」。
//
// 背景：wanx2.1-imageedit 等扩散 inpaint 模型会系统性地轻微改写 mask 外区域
// （全局重压缩 / 色偏 / 微噪声），并不真正"只改这块"。本模块两段式保证：
//   1. diff-gate：仅在 mask 留区（黑）逐像素比较原图 vs 模型输出，度量漂移。
//   2. region-lock：留区漂移越界时，把原图留区逐像素贴回，保证"其余不变"，并产出 diff 证据。
//
// 纯像素函数（diffOutsideMask/compositeRegionLock/buildDiffOverlay）不依赖 sharp，可单测；
// runRegionLockGate 注入 sharp 做编解码 + resize 对齐。
import type { SharpModule } from '../../runtime/sharpRuntime';
import type { RegionLockReport } from '../../../shared/contract/imageConsistency';

/** 解码后的原始位图（RGB 或 RGBA 打包）。 */
export interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number; // 3 或 4
}

/** diff-gate 度量结果（不含处置）。 */
export interface DiffMetrics {
  maxDelta: number;
  meanDelta: number;
  changedPixels: number;
  keepPixels: number;
  passed: boolean;
}

// mask 灰度 >= 该值视为白（编辑区）；否则黑（留区）。
const MASK_EDIT_THRESHOLD = 128;

/** 该像素是否落在编辑区（mask 白）。读 mask 通道 0 作灰度（黑/白图足够）。 */
function isEditPixel(mask: RawImage, pixelIndex: number): boolean {
  return mask.data[pixelIndex * mask.channels] >= MASK_EDIT_THRESHOLD;
}

/** 单像素 RGB 三通道的最大绝对差（忽略 alpha）。 */
function pixelChannelDelta(a: RawImage, b: RawImage, pixelIndex: number): number {
  const ai = pixelIndex * a.channels;
  const bi = pixelIndex * b.channels;
  const dr = Math.abs(a.data[ai] - b.data[bi]);
  const dg = Math.abs(a.data[ai + 1] - b.data[bi + 1]);
  const db = Math.abs(a.data[ai + 2] - b.data[bi + 2]);
  return Math.max(dr, dg, db);
}

function assertSameDims(a: RawImage, b: RawImage, mask: RawImage): void {
  if (a.width !== b.width || a.height !== b.height || a.width !== mask.width || a.height !== mask.height) {
    throw new Error('imageConsistency: original/edited/mask 尺寸必须一致（请先 resize 对齐）');
  }
}

/**
 * diff-gate：仅在 mask 留区（黑）逐像素比较 original vs edited。
 * passed = 留区最大通道差 ≤ epsilon（留区为空时视为通过——无可越界区）。
 */
export function diffOutsideMask(
  original: RawImage,
  edited: RawImage,
  mask: RawImage,
  epsilon: number,
): DiffMetrics {
  assertSameDims(original, edited, mask);
  const total = original.width * original.height;
  let maxDelta = 0;
  let sumDelta = 0;
  let changedPixels = 0;
  let keepPixels = 0;
  for (let p = 0; p < total; p++) {
    if (isEditPixel(mask, p)) continue; // 编辑区不参与一致性校验
    keepPixels++;
    const delta = pixelChannelDelta(original, edited, p);
    if (delta > maxDelta) maxDelta = delta;
    sumDelta += delta;
    if (delta > epsilon) changedPixels++;
  }
  return {
    maxDelta,
    meanDelta: keepPixels ? sumDelta / keepPixels : 0,
    changedPixels,
    keepPixels,
    passed: maxDelta <= epsilon,
  };
}

/**
 * region-lock：编辑区（mask 白）取模型输出，留区（mask 黑）逐像素回到原图。
 * 输出 RGBA，保证留区与原图逐像素一致（"只改这块其余不变"的硬保证）。
 */
export function compositeRegionLock(original: RawImage, edited: RawImage, mask: RawImage): RawImage {
  assertSameDims(original, edited, mask);
  const w = original.width;
  const h = original.height;
  const out = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    const src = isEditPixel(mask, p) ? edited : original;
    const si = p * src.channels;
    out[o] = src.data[si];
    out[o + 1] = src.data[si + 1];
    out[o + 2] = src.data[si + 2];
    out[o + 3] = src.channels === 4 ? src.data[si + 3] : 255;
  }
  return { data: out, width: w, height: h, channels: 4 };
}

/**
 * diff 证据图：以变暗的模型输出为底，把留区中越界（delta > epsilon）的像素标红。
 * 一眼看出"模型偷改了哪些未选区域"。输出 RGBA。
 */
export function buildDiffOverlay(
  original: RawImage,
  edited: RawImage,
  mask: RawImage,
  epsilon: number,
): RawImage {
  assertSameDims(original, edited, mask);
  const w = original.width;
  const h = original.height;
  const out = new Uint8Array(w * h * 4);
  const DIM = 0.35; // 底图压暗，让红色越界标记更醒目
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    const ei = p * edited.channels;
    const violated = !isEditPixel(mask, p) && pixelChannelDelta(original, edited, p) > epsilon;
    if (violated) {
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 0;
    } else {
      out[o] = Math.round(edited.data[ei] * DIM);
      out[o + 1] = Math.round(edited.data[ei + 1] * DIM);
      out[o + 2] = Math.round(edited.data[ei + 2] * DIM);
    }
    out[o + 3] = 255;
  }
  return { data: out, width: w, height: h, channels: 4 };
}

// ---- sharp 编解码包装 ----

async function decodeRaw(
  sharp: SharpModule,
  buf: Buffer,
  resize?: { width: number; height: number; nearest?: boolean },
): Promise<RawImage> {
  let pipe = sharp(buf);
  if (resize) {
    pipe = pipe.resize(resize.width, resize.height, {
      fit: 'fill',
      kernel: resize.nearest ? 'nearest' : 'lanczos3',
    });
  }
  const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    // 拷贝到独立 ArrayBuffer：sharp raw Buffer 对小图走 Node 内存池(<4KB 共享 backing)，
    // 直接做 view 会与后续 decode 别名串扰；copy 隔离掉这一类潜在内存损坏。
    data: new Uint8Array(data),
    width: info.width,
    height: info.height,
    channels: info.channels,
  };
}

function encodePng(sharp: SharpModule, raw: RawImage): Promise<Buffer> {
  return sharp(Buffer.from(raw.data), {
    raw: { width: raw.width, height: raw.height, channels: raw.channels as 1 | 2 | 3 | 4 },
  })
    .png()
    .toBuffer();
}

// ---- 严格模式守卫（可选硬保证）----
// best-effort（默认）：sharp 不可用 / 闸抛错时降级写模型原图，不阻断编辑。
// strict（用户在设置页开启）：region-lock 无法强制执行时「响亮失败」，拒绝产出未经一致性保证的图。
// main 侧抛出的错误直接回传 renderer 展示，故消息走中文硬编码（与既有 handler 错误一致）。

export const REGION_LOCK_STRICT_SHARP_UNAVAILABLE =
  '一致性严格模式已开启，但图像处理组件 (sharp) 不可用，无法保证未选区域不被改动。已取消本次局部重绘（未调用付费模型，不产生费用）。';

export const REGION_LOCK_STRICT_GATE_FAILED =
  '一致性严格模式已开启，但一致性校验执行失败，已拒绝写入未经保证的结果（模型原图未落盘，可关闭严格模式后重试）。';

/**
 * 严格模式预检：region-lock 能否被强制执行。
 * - sharp 可用：返回 true（继续跑一致性闸，与是否严格无关）。
 * - sharp 不可用 + 严格：抛错（拒绝产出未保证产物）。**调用方须在付费生成前调用**，避免白付费。
 * - sharp 不可用 + 非严格：返回 false（best-effort 降级，调用方写模型原图、不阻断编辑）。
 */
export function ensureRegionLockEnforceable(opts: { strict: boolean; sharpAvailable: boolean }): boolean {
  if (opts.sharpAvailable) return true;
  if (opts.strict) throw new Error(REGION_LOCK_STRICT_SHARP_UNAVAILABLE);
  return false;
}

/**
 * 一致性闸自身执行失败（sharp 已加载但解码/处理抛错）时的处置：
 * - 严格：抛错（链上原因），拒绝写未保证产物。
 * - 非严格：静默返回，由调用方降级写模型原图。
 */
export function onRegionLockGateError(opts: { strict: boolean; cause: unknown }): void {
  if (!opts.strict) return;
  const err = new Error(REGION_LOCK_STRICT_GATE_FAILED) as Error & { cause?: unknown };
  err.cause = opts.cause;
  throw err;
}

export interface RegionLockGateResult {
  /** 最终产物 PNG（clean=模型输出；locked=留区贴回原图后的合成图）。 */
  finalPng: Buffer;
  /** 一致性报告。 */
  report: RegionLockReport;
  /** diff 证据图 PNG（仅 locked 时非 null）。 */
  diffPng: Buffer | null;
}

/**
 * 一致性闸：原图 + mask + 模型输出 → diff-gate 度量 → 通过则直接采用（clean），
 * 越界则 region-lock 贴回原图留区 + 产出 diff 证据（locked）。
 * edited/mask 尺寸不一致时先 resize 对齐到原图尺寸（dimensionMatched=false）。
 */
export async function runRegionLockGate(input: {
  originalBuf: Buffer;
  editedBuf: Buffer;
  maskBuf: Buffer;
  epsilon: number;
  sharp: SharpModule;
}): Promise<RegionLockGateResult> {
  const { sharp, epsilon } = input;
  const original = await decodeRaw(sharp, input.originalBuf);
  const { width, height } = original;

  const editedMeta = await sharp(input.editedBuf).metadata();
  const dimensionMatched = editedMeta.width === width && editedMeta.height === height;

  const edited = dimensionMatched
    ? await decodeRaw(sharp, input.editedBuf)
    : await decodeRaw(sharp, input.editedBuf, { width, height });
  const mask = await decodeRaw(sharp, input.maskBuf, { width, height, nearest: true });

  const metrics = diffOutsideMask(original, edited, mask, epsilon);

  if (metrics.passed) {
    // 模型自身守住未选区：采用模型输出(不引入合成接缝)。统一重编码为 PNG——
    // editedBuf 可能是 JPEG/WebP 字节(下游按 .png 落盘)，重编码保证产物始终是合法 PNG。
    // 像素取自已解码的 RGBA，PNG 无损，不改动模型像素。
    return {
      finalPng: await encodePng(sharp, edited),
      diffPng: null,
      report: {
        passed: true,
        status: 'clean',
        maxDelta: metrics.maxDelta,
        meanDelta: metrics.meanDelta,
        changedPixels: metrics.changedPixels,
        keepPixels: metrics.keepPixels,
        epsilon,
        dimensionMatched,
      },
    };
  }

  // 越界：region-lock 贴回原图留区 + diff 证据。
  const locked = compositeRegionLock(original, edited, mask);
  const overlay = buildDiffOverlay(original, edited, mask, epsilon);
  return {
    finalPng: await encodePng(sharp, locked),
    diffPng: await encodePng(sharp, overlay),
    report: {
      passed: false,
      status: 'locked',
      maxDelta: metrics.maxDelta,
      meanDelta: metrics.meanDelta,
      changedPixels: metrics.changedPixels,
      keepPixels: metrics.keepPixels,
      epsilon,
      dimensionMatched,
    },
  };
}
