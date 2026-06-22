// 厚版演示稿（二期）导出 handler——从 workspace.ipc.ts 拆出（控制 godfile 行数）。
// topic + 页数 → slidesGenerator 真排版 deck（非图片塞 PPT）→ saveBinaryToDownloads。
// 不调付费模型；topic 必填。
import { generateSlidesDeck } from '../services/design/slidesGenerator';
import { handleSaveBinaryToDownloads } from './workspaceSaveExport';

export interface GenerateSlidesDeckPayload {
  topic?: string;
  slidesCount?: number;
  theme?: string;
  content?: string;
  outputName?: string;
}

export async function handleGenerateSlidesDeck(
  payload: GenerateSlidesDeckPayload,
): Promise<{ filePath: string; slidesCount: number }> {
  if (!payload?.topic?.trim() || !payload.outputName) {
    throw new Error('generateSlidesDeck 需要 topic 与 outputName');
  }
  const { buffer, slidesCount } = await generateSlidesDeck({
    topic: payload.topic,
    slidesCount: payload.slidesCount,
    theme: payload.theme,
    content: payload.content,
  });
  const saved = await handleSaveBinaryToDownloads({
    fileName: payload.outputName,
    base64: buffer.toString('base64'),
  });
  return { filePath: saved.filePath, slidesCount };
}
