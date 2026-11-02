// ============================================================================
// imageMultiRefService — 多参考图（2-3 张）编辑生成（N-IMAGE-MULTI-REF-IMPL）
//
// 百炼 qwen-image-2.0-pro（qwen-image-edit 同步 multimodal-generation 端点）：
// input.messages[0].content[] = N × {image: dataURL}（按数组顺序，指令里用「图1/图2/图3」
// 指代）+ 恰好一条 {text: 指令}，parameters.n = 1。
//
// 文档（DashScope qwen-image-edit API，zh/en，2026-10-29 抓取，全引见
// docs/research/2026-10-image-multi-ref-probe.md）不定义哪张是"主体图"；输出比例以
// 最后一张图为准——故**不发送 size**，调用方的 aspect_ratio 在多参考图路径上被忽略。
//
// 单参考图仍走 imageGenerationService.generateImageFromReference（wanx
// description_edit，0.14 元/张，请求字节不变）；本 service 只接 2-3 张。
// key 复用既有 getDashscopeApiKey（env 优先回落 config 槽），零新增配置。
// ============================================================================

import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { IMAGE_MULTI_REF } from '../../../shared/constants/visualModels';
import {
  fetchWithAbort,
  getDashscopeApiKey,
  downloadImageAsBase64,
  isImageUrl,
  type GenerateImageResult,
} from './imageGenerationService';

/** content 条目：{image: dataURL} 或 {text: 指令}。 */
type MultiRefContentEntry = { image: string } | { text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 multimodal-generation 响应解析结果图 URL。
 * 预期形状（qwen-image-edit 文档例）：output.choices[0].message.content[] 里带 image 字符串；
 * 兼容 content 为纯字符串的 chat 形状（取首个 https URL）。形状不符返回 undefined。
 */
function parseMultiRefImageUrl(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const output = isRecord(payload.output) ? payload.output : undefined;
  const choices = output && Array.isArray(output.choices) ? output.choices : undefined;
  const message = choices && isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message : undefined;
  if (!message) return undefined;
  if (Array.isArray(message.content)) {
    for (const entry of message.content) {
      if (isRecord(entry) && typeof entry.image === 'string') return entry.image;
    }
    return undefined;
  }
  if (typeof message.content === 'string') {
    return message.content.match(/https:\/\/\S+/)?.[0];
  }
  return undefined;
}

/**
 * 多参考图编辑编排（供 image_generate 工具与设计画布 IPC 调用）：
 * 校验 DashScope key → 同步生成（2-3 张图按数组顺序 + 一条指令）→ 下载结果为 dataURL。
 * 返回 {imageData(dataURL), actualModel}，与 generateImageFromReference 出参同构。
 * referenceImageDataUrls 由调用方保证 2-3 张（上限闸在调用方，本层不再重复）。
 */
export async function generateImageFromReferences(input: {
  prompt: string;
  referenceImageDataUrls: string[];
  outerSignal?: AbortSignal;
}): Promise<GenerateImageResult> {
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('多参考图生成需要百炼（DashScope）API Key。');
  // 恰好一条 text（多条 text 端点报错，doc-quoted）；图在前、按数组顺序，指令殿后。
  const content: MultiRefContentEntry[] = [
    ...input.referenceImageDataUrls.map((dataUrl) => ({ image: dataUrl })),
    { text: input.prompt },
  ];
  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.dashscope}${IMAGE_MULTI_REF.GENERATION_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: IMAGE_MULTI_REF.MODEL,
        input: { messages: [{ role: 'user', content }] },
        parameters: { n: 1 },
      }),
    },
    IMAGE_MULTI_REF.GENERATION_TIMEOUT_MS,
    input.outerSignal ?? new AbortController().signal,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`多参考图生成失败（模型: ${IMAGE_MULTI_REF.MODEL}）: ${response.status} - ${errorText}`);
  }
  const payload: unknown = await response.json();
  const url = parseMultiRefImageUrl(payload);
  if (!url) {
    throw new Error(`多参考图生成（模型: ${IMAGE_MULTI_REF.MODEL}）: 未返回图片 URL`);
  }
  const imageData = isImageUrl(url) ? await downloadImageAsBase64(url, input.outerSignal) : url;
  return { imageData, actualModel: IMAGE_MULTI_REF.MODEL };
}
