// 厚版演示稿（二期）导出 handler——从 workspace.ipc.ts 拆出（控制 godfile 行数）。
// topic + 页数 → slidesGenerator 真排版 deck（非图片塞 PPT）→ saveBinaryToDownloads。
// 不调付费模型；topic 必填。
import { promises as fsp } from 'fs';
import path from 'path';
import { generateSlidesDeck, buildSlidesOutline } from '../services/design/slidesGenerator';
import { buildAiOutline } from '../services/design/slidesAiOutline';
import { imagesToPptx } from '../services/design/pptxExport';
import { convertToScreenshots, isLibreOfficeAvailable } from '../tools/media/ppt/visualReview';
import { getUserConfigDir } from '../config/configPaths';
import type { SlideData } from '../tools/media/ppt/types';
import { handleSaveBinaryToDownloads } from './workspaceSaveExport';
import { assertWithinDesignDir } from './workspaceDesignPaths';

// 画布产物多张 → 全幅 PPTX（CD-Parity §4 薄版）→ 落「下载」。每张来源二选一：
// imagePath（磁盘，须落设计目录内防越界读任意文件）或 dataUrl（renderer 传 base64）。
export async function handleExportCanvasPptx(payload: {
  images?: Array<{ imagePath?: string; dataUrl?: string }>;
  outputName: string;
}): Promise<{ filePath: string }> {
  if (!payload?.outputName || !Array.isArray(payload.images) || payload.images.length === 0) {
    throw new Error('exportCanvasPptx 需要 outputName 与至少一张 images');
  }
  const buffers: Buffer[] = [];
  for (const src of payload.images) {
    if (src?.imagePath) {
      assertWithinDesignDir(src.imagePath, 'imagePath');
      buffers.push(await fsp.readFile(src.imagePath));
    } else if (src?.dataUrl) {
      const base64 = src.dataUrl.replace(/^data:[^;]+;base64,/, '');
      buffers.push(Buffer.from(base64, 'base64'));
    } else {
      throw new Error('exportCanvasPptx 的每张 images 需要 imagePath 或 dataUrl 之一');
    }
  }
  const pptx = await imagesToPptx(buffers);
  return handleSaveBinaryToDownloads({ fileName: payload.outputName, base64: pptx.toString('base64') });
}

export interface GenerateSlidesDeckPayload {
  topic?: string;
  slidesCount?: number;
  theme?: string;
  content?: string;
  /** 已编辑大纲：提供则据此排版，优先于 topic/content。 */
  slides?: SlideData[];
  outputName?: string;
}

export interface GenerateSlidesOutlinePayload {
  topic?: string;
  slidesCount?: number;
  /** true=AI 增强大纲（付费，调文本模型）；缺省=确定性 SCQA 模板（免费）。 */
  ai?: boolean;
}

// 大纲生成（厚版第一步）：topic + 页数 → SlideData[]（不落盘）。
// ai=true 走付费文本模型（无 key/失败自动降级确定性，aiUsed 反映实际）；缺省走免费模板。
export async function handleGenerateSlidesOutline(
  payload: GenerateSlidesOutlinePayload,
): Promise<{ slides: SlideData[]; aiUsed: boolean }> {
  if (!payload?.topic?.trim()) {
    throw new Error('generateSlidesOutline 需要 topic');
  }
  if (payload.ai) {
    const r = await buildAiOutline(payload.topic, payload.slidesCount);
    return { slides: r.slides, aiUsed: r.ai };
  }
  return { slides: buildSlidesOutline(payload.topic, payload.slidesCount), aiUsed: false };
}

export interface GenerateSlidesPreviewPayload {
  topic?: string;
  slidesCount?: number;
  theme?: string;
  content?: string;
  slides?: SlideData[];
}

// 像素级预览（增强 #2）：据 topic/大纲生成 deck → 写 design 临时目录 → LibreOffice 转每页 PNG。
// LibreOffice 未安装时返回 libreOfficeMissing=true，由前端引导安装。转换免费（本地）。
export async function handleGenerateSlidesPreview(payload: GenerateSlidesPreviewPayload): Promise<{
  screenshots: string[];
  slidesCount: number;
  libreOfficeMissing?: boolean;
}> {
  const hasSlides = Array.isArray(payload?.slides) && payload.slides.length > 0;
  if (!payload?.topic?.trim() && !hasSlides) {
    throw new Error('generateSlidesPreview 需要 topic 或 slides');
  }
  if (!isLibreOfficeAvailable()) {
    return { screenshots: [], slidesCount: 0, libreOfficeMissing: true };
  }
  const { buffer, slidesCount } = await generateSlidesDeck({
    topic: payload.topic,
    slidesCount: payload.slidesCount,
    theme: payload.theme,
    content: payload.content,
    slides: payload.slides,
  });
  const dir = path.join(getUserConfigDir(), 'design', 'slides-preview');
  await fsp.rm(dir, { recursive: true, force: true }); // 清旧预览，避免堆积
  await fsp.mkdir(dir, { recursive: true });
  const pptxPath = path.join(dir, 'preview.pptx');
  await fsp.writeFile(pptxPath, buffer);
  const screenshots = await convertToScreenshots(pptxPath, path.join(dir, 'png'));
  return { screenshots, slidesCount };
}

export async function handleGenerateSlidesDeck(
  payload: GenerateSlidesDeckPayload,
): Promise<{ filePath: string; slidesCount: number }> {
  const hasSlides = Array.isArray(payload?.slides) && payload.slides.length > 0;
  if ((!payload?.topic?.trim() && !hasSlides) || !payload.outputName) {
    throw new Error('generateSlidesDeck 需要 topic 或 slides，以及 outputName');
  }
  const { buffer, slidesCount } = await generateSlidesDeck({
    topic: payload.topic,
    slidesCount: payload.slidesCount,
    theme: payload.theme,
    content: payload.content,
    slides: payload.slides,
  });
  const saved = await handleSaveBinaryToDownloads({
    fileName: payload.outputName,
    base64: buffer.toString('base64'),
  });
  return { filePath: saved.filePath, slidesCount };
}
