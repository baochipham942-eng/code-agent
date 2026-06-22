// 厚版演示稿（二期）导出 handler——从 workspace.ipc.ts 拆出（控制 godfile 行数）。
// topic + 页数 → slidesGenerator 真排版 deck（非图片塞 PPT）→ saveBinaryToDownloads。
// 不调付费模型；topic 必填。
import { promises as fsp } from 'fs';
import { generateSlidesDeck, buildSlidesOutline } from '../services/design/slidesGenerator';
import { imagesToPptx } from '../services/design/pptxExport';
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
}

// 大纲生成（厚版第一步）：topic + 页数 → 确定性 SlideData[]（不落盘、不付费）。
export async function handleGenerateSlidesOutline(
  payload: GenerateSlidesOutlinePayload,
): Promise<{ slides: SlideData[] }> {
  if (!payload?.topic?.trim()) {
    throw new Error('generateSlidesOutline 需要 topic');
  }
  return { slides: buildSlidesOutline(payload.topic, payload.slidesCount) };
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
