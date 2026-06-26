// 演示稿 AI 配图（增强 #4）：为内容页调设计 tab 同款生图模型（wanx/cogview/flux/gptimage，
// 用户在页面选）生成概念插画 → 写盘 → SlideImage[]，喂进 fillSlide 走图文母版。付费——
// 前端 opt-in + 出图前预估。模型→engine 解析与 handleGenerateDesignImage 同源。
import path from 'path';
import { promises as fsp } from 'fs';
import { imageEngineForModel } from '@shared/constants/visualModels';
import { DESIGN_FLUX_MODEL } from '@shared/constants/pricing';
import { estimateImageCostCny } from '@shared/media/imageCost';
import type { SlideData, SlideImage } from '../../tools/media/ppt/types';

const DEFAULT_MAX_IMAGES = 4;

export interface IllustrateOptions {
  /** 设计 tab 图模型 id（wanx-t2i / cogview / flux / gptimage…）。 */
  modelId: string;
  maxImages?: number;
  aspectRatio?: string;
}

export interface IllustrateResult {
  images: SlideImage[];
  costCny: number;
  count: number;
}

/** 选出适合配图的页（纯函数，可测）：非封面/结尾、有标题的内容页，取前 maxImages 个。 */
export function selectIllustrationTargets(slides: SlideData[], maxImages: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < slides.length && idx.length < maxImages; i++) {
    const s = slides[i];
    if (s.isTitle || s.isEnd) continue;
    if (!s.title?.trim()) continue;
    idx.push(i);
  }
  return idx;
}

/** 内容页 → 配图提示词（要求无文字，契合商务演示气质）。 */
export function buildIllustrationPrompt(slide: SlideData): string {
  const pts = (slide.points ?? []).slice(0, 2).join('，');
  return (
    `为演示稿页面「${slide.title}」生成一张概念化插画${pts ? `（主题要点：${pts}）` : ''}，` +
    '简洁现代、契合商务演示气质，构图留白充足，不要出现任何文字。'
  );
}

/** 出图前预估：目标页数 × 单张成本（按所选模型查价表）。 */
export function estimateIllustrateCost(
  slides: SlideData[],
  modelId: string,
  maxImages?: number,
): { count: number; costCny: number } {
  const count = selectIllustrationTargets(slides, maxImages ?? DEFAULT_MAX_IMAGES).length;
  return { count, costCny: count * estimateImageCostCny(modelId) };
}

/**
 * 真出图（付费）：逐目标页 generateImage → 写盘 → SlideImage[]。
 * 单页失败不阻塞整体（跳过该页，回退纯文字版式）；成本按真实落地模型累加。
 */
export async function illustrateSlides(
  slides: SlideData[],
  opts: IllustrateOptions,
  outputDir: string,
): Promise<IllustrateResult> {
  const targets = selectIllustrationTargets(slides, opts.maxImages ?? DEFAULT_MAX_IMAGES);
  if (targets.length === 0) return { images: [], costCny: 0, count: 0 };

  const engine = imageEngineForModel(opts.modelId);
  const fluxModelArg = engine === 'flux' ? DESIGN_FLUX_MODEL : '';
  const aspectRatio = opts.aspectRatio ?? '16:9';
  const { generateImage, downloadImageAsBase64, isImageUrl } = await import(
    '../media/imageGenerationService'
  );

  await fsp.mkdir(outputDir, { recursive: true });
  const images: SlideImage[] = [];
  let costCny = 0;
  for (const i of targets) {
    try {
      const { imageData, actualModel } = await generateImage(
        engine,
        fluxModelArg,
        buildIllustrationPrompt(slides[i]),
        aspectRatio,
      );
      const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const imagePath = path.join(outputDir, `slide-${i}.png`);
      await fsp.writeFile(imagePath, Buffer.from(base64, 'base64'));
      images.push({ slide_index: i, image_path: imagePath, position: 'right' });
      costCny += estimateImageCostCny(actualModel);
    } catch {
      // 单页配图失败：跳过该页，不阻塞其余页与整体生成。
    }
  }
  return { images, costCny, count: images.length };
}
