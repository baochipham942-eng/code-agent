// ============================================================================
// imageGenerationService — host-accessible image generation primitives
//
// 这一层是 host 可直接调用的图像生成原语，剥离自 `tools/modules/network/imageGenerate`，
// 用于解开 `tools/media/ppt/illustrationAgent` 与 image_generate 工具内部函数的耦合。
// image_generate 工具与 PPT illustrationAgent 都从这里调用，
// 不再相互直接 import 内部实现。
//
// 注意：本 service 只提供纯函数原语（决定引擎、下载图片、调用智谱/OpenRouter 出图），
// 不感知 ToolContext / ToolSchema / Permission，调用方各自负责权限和上下文。
// ============================================================================

import { getConfigService } from '../core/configService';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';

export type ImageEngine = 'cogview' | 'flux' | 'wanx';

export interface GenerateImageResult {
  imageData: string;
  actualModel: string;
}

const TIMEOUT_MS = {
  DIRECT_API: 90000,
  IMAGE_DOWNLOAD: 30000,
  // 通义万相异步任务：单次轮询超时 + 轮询间隔 + 总超时。
  WANX_POLL: 15000,
  WANX_POLL_INTERVAL: 3000,
  WANX_TOTAL: 120000,
};

const ZHIPU_IMAGE_MODELS = {
  standard: 'cogview-4-250304',
  legacy: 'cogview-3-flash',
} as const;

// 通义万相（DashScope 原生异步 API）：文生图模型 + 端点路径。
const WANX_T2I_MODEL = 'wanx2.1-t2i-turbo';
const WANX_T2I_PATH = '/services/aigc/text2image/image-synthesis';
const WANX_TASKS_PATH = '/tasks';
const WANX_SIZE_BY_ASPECT = new Map<string, string>([
  ['1:1', '1024*1024'],
  ['16:9', '1280*720'],
  ['9:16', '720*1280'],
  ['4:3', '1024*768'],
  ['3:4', '768*1024'],
]);

const NO_TEXT_SUFFIX = '，画面中不要出现任何文字、字母、数字、标题、标签、水印、签名，纯视觉画面';

interface OpenRouterImageMessage {
  images?: Array<{
    image_url?: { url?: string };
    imageUrl?: { url?: string };
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseZhipuImageUrl(value: unknown): string | null {
  if (!isRecord(value) || !isUnknownArray(value.data)) return null;
  const [first] = value.data;
  return isRecord(first) && typeof first.url === 'string' ? first.url : null;
}

function parseOpenRouterImageResponse(value: unknown): { choices?: Array<{ message?: OpenRouterImageMessage }> } {
  if (!isRecord(value) || !isUnknownArray(value.choices)) return {};
  const choices = value.choices
    .map((choice): { message?: OpenRouterImageMessage } => {
      if (!isRecord(choice) || !isRecord(choice.message) || !isUnknownArray(choice.message.images)) {
        return {};
      }
      const images: NonNullable<OpenRouterImageMessage['images']> = [];
      for (const image of choice.message.images) {
        if (!isRecord(image)) continue;
        const imageUrl = isRecord(image.image_url) && typeof image.image_url.url === 'string'
            ? { url: image.image_url.url }
            : undefined;
        const camelImageUrl = isRecord(image.imageUrl) && typeof image.imageUrl.url === 'string'
            ? { url: image.imageUrl.url }
            : undefined;
        if (imageUrl || camelImageUrl) {
          images.push({ image_url: imageUrl, imageUrl: camelImageUrl });
        }
      }
      return { message: { images } };
    });
  return { choices };
}

async function fetchWithAbort(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onOuterAbort);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

function getZhipuOfficialApiKey(): string | undefined {
  const officialKey = process.env.ZHIPU_OFFICIAL_API_KEY;
  if (officialKey) return officialKey;
  const configService = getConfigService();
  const zhipuKey = configService.getApiKey('zhipu');
  if (zhipuKey && !zhipuKey.startsWith('oki-')) return zhipuKey;
  return undefined;
}

/** 百炼 DashScope key（通义万相用）。env 优先（验证场景），否则取 qwen/dashscope 槽位。 */
export function getDashscopeApiKey(): string | undefined {
  const envKey = process.env.DASHSCOPE_API_KEY;
  if (envKey) return envKey;
  const configService = getConfigService();
  return configService.getApiKey('dashscope') || configService.getApiKey('qwen') || undefined;
}

export function determineImageEngine(): ImageEngine {
  if (getZhipuOfficialApiKey()) return 'cogview';
  const configService = getConfigService();
  if (configService.getApiKey('openrouter')) return 'flux';
  throw new Error('图片生成需要本地 API Key：请在设置中配置智谱（CogView-4）或 OpenRouter（FLUX）API Key。');
}

export function isImageUrl(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

export async function downloadImageAsBase64(
  url: string,
  outerSignal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const response = await fetchWithAbort(url, {}, TIMEOUT_MS.IMAGE_DOWNLOAD, outerSignal);
  if (!response.ok) {
    throw new Error(`图片下载失败: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/png';
  return `data:${contentType};base64,${base64}`;
}

function extractImageFromResponse(result: { choices?: Array<{ message?: OpenRouterImageMessage }> }): string {
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error('响应格式错误: 无 message');
  }
  const images = message.images;
  if (!images || images.length === 0) {
    throw new Error('未返回图片数据');
  }
  const imageUrl = images[0].image_url?.url || images[0].imageUrl?.url;
  if (!imageUrl) {
    throw new Error('图片 URL 格式错误');
  }
  return imageUrl;
}

async function callZhipuImageGeneration(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const sizeMap = new Map<string, string>([
    ['1:1', '1024x1024'],
    ['16:9', '1344x768'],
    ['9:16', '768x1344'],
    ['4:3', '1152x864'],
    ['3:4', '864x1152'],
  ]);
  const size = sizeMap.get(aspectRatio) || '1024x1024';

  const requestBody = {
    model: ZHIPU_IMAGE_MODELS.standard,
    prompt,
    size,
  };

  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.zhipuOfficial}/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.DIRECT_API,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱图像生成 API 错误: ${response.status} - ${error}`);
  }

  const payload: unknown = await response.json();
  const url = parseZhipuImageUrl(payload);
  if (!url) {
    throw new Error('智谱图像生成: 未返回图片 URL');
  }
  return { url };
}

function parseWanxTask(value: unknown): { taskId?: string; status?: string; url?: string; message?: string } {
  if (!isRecord(value)) return {};
  const output = isRecord(value.output) ? value.output : {};
  const taskId = typeof output.task_id === 'string' ? output.task_id : undefined;
  const status = typeof output.task_status === 'string' ? output.task_status : undefined;
  const message = typeof output.message === 'string' ? output.message : (typeof value.message === 'string' ? value.message : undefined);
  let url: string | undefined;
  if (isUnknownArray(output.results) && output.results.length > 0) {
    const first = output.results[0];
    if (isRecord(first) && typeof first.url === 'string') url = first.url;
  }
  return { taskId, status, url, message };
}

/**
 * 通义万相文生图（DashScope 原生异步 API）：提交任务 → 轮询直到 SUCCEEDED/FAILED。
 * 返回最终图片 URL（OSS，临时有效，调用方需下载）。
 */
async function callWanxImageGeneration(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const size = WANX_SIZE_BY_ASPECT.get(aspectRatio) || '1024*1024';
  const submitResp = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.dashscope}${WANX_T2I_PATH}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify({
        model: WANX_T2I_MODEL,
        input: { prompt },
        parameters: { size, n: 1 },
      }),
    },
    TIMEOUT_MS.WANX_POLL,
    outerSignal,
  );
  if (!submitResp.ok) {
    throw new Error(`通义万相提交失败: ${submitResp.status} - ${await submitResp.text()}`);
  }
  const submitted = parseWanxTask(await submitResp.json());
  if (!submitted.taskId) {
    throw new Error('通义万相: 未返回 task_id');
  }

  const deadline = Date.now() + TIMEOUT_MS.WANX_TOTAL;
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, TIMEOUT_MS.WANX_POLL_INTERVAL));
    const pollResp = await fetchWithAbort(
      `${MODEL_API_ENDPOINTS.dashscope}${WANX_TASKS_PATH}/${submitted.taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      TIMEOUT_MS.WANX_POLL,
      outerSignal,
    );
    if (!pollResp.ok) continue; // 瞬时失败不致命，继续轮询
    const task = parseWanxTask(await pollResp.json());
    if (task.status === 'SUCCEEDED') {
      if (!task.url) throw new Error('通义万相: 任务成功但无图片 URL');
      return { url: task.url };
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED' || task.status === 'UNKNOWN') {
      throw new Error(`通义万相任务失败: ${task.status}${task.message ? ` - ${task.message}` : ''}`);
    }
  }
  throw new Error('通义万相任务超时');
}

export async function generateImage(
  engine: ImageEngine,
  fluxModel: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal = new AbortController().signal,
): Promise<GenerateImageResult> {
  const configService = getConfigService();
  const safePrompt = prompt.includes('不要出现任何文字') ? prompt : prompt + NO_TEXT_SUFFIX;

  if (engine === 'wanx') {
    const dashscopeKey = getDashscopeApiKey();
    if (!dashscopeKey) {
      throw new Error('通义万相需要百炼（DashScope）API Key。');
    }
    // 设计稿/信息图常需文字，使用原始 prompt（不追加"禁止文字"后缀）。
    const result = await callWanxImageGeneration(dashscopeKey, prompt, aspectRatio, outerSignal);
    return { imageData: result.url, actualModel: WANX_T2I_MODEL };
  }

  if (engine === 'cogview') {
    const zhipuApiKey = getZhipuOfficialApiKey();
    if (!zhipuApiKey) {
      throw new Error('图片生成需要智谱官方 API Key。');
    }
    const result = await callZhipuImageGeneration(zhipuApiKey, safePrompt, aspectRatio, outerSignal);
    return { imageData: result.url, actualModel: ZHIPU_IMAGE_MODELS.standard };
  }

  // engine === 'flux'
  const openrouterApiKey = configService.getApiKey('openrouter');
  if (!openrouterApiKey) {
    throw new Error('图片生成需要 OpenRouter API Key。');
  }
  const requestBody = {
    model: fluxModel,
    messages: [{ role: 'user', content: safePrompt }],
    modalities: ['image'],
    image_config: { aspect_ratio: aspectRatio },
  };

  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.openrouter}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openrouterApiKey}`,
        'HTTP-Referer': 'https://code-agent.app',
        'X-Title': 'Agent Neo',
      },
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.DIRECT_API,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API 调用失败: ${error}`);
  }
  const payload: unknown = await response.json();
  const result = parseOpenRouterImageResponse(payload);
  const imageData = extractImageFromResponse(result);
  return { imageData, actualModel: fluxModel };
}
