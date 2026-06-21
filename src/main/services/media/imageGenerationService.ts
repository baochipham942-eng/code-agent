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

export type ImageEngine = 'cogview' | 'flux' | 'wanx' | 'gptimage';

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
  // gpt-image-2 经第三方中转的同步出图请求超时。
  GPTIMAGE_GENERATION: 120000,
};

const ZHIPU_IMAGE_MODELS = {
  standard: 'cogview-4-250304',
  legacy: 'cogview-3-flash',
} as const;

// 通义万相（DashScope 原生异步 API）：文生图 + 局部重绘模型 + 端点路径。
const WANX_T2I_MODEL = 'wanx2.1-t2i-turbo';
const WANX_T2I_PATH = '/services/aigc/text2image/image-synthesis';
const WANX_EDIT_MODEL = 'wanx2.1-imageedit';
const WANX_EDIT_PATH = '/services/aigc/image2image/image-synthesis';
export const WANX_TASKS_PATH = '/tasks';
const WANX_SIZE_BY_ASPECT = new Map<string, string>([
  ['1:1', '1024*1024'],
  ['16:9', '1280*720'],
  ['9:16', '720*1280'],
  ['4:3', '1024*768'],
  ['3:4', '768*1024'],
]);
// 通义万相扩图（function=expand）单边外扩比例范围；去水印默认 prompt（API 要求非空，语义不强制）。
const WANX_EXPAND_SCALE_MIN = 1.0;
const WANX_EXPAND_SCALE_MAX = 2.0;
const DEFAULT_REMOVE_WATERMARK_PROMPT = '去除图像中的文字水印';

const NO_TEXT_SUFFIX = '，画面中不要出现任何文字、字母、数字、标题、标签、水印、签名，纯视觉画面';

// gpt-image-2 经第三方中转（OpenAI 兼容 /v1/images/generations，返回 b64_json）。
const GPTIMAGE_MODEL = 'gpt-image-2';
const GPTIMAGE_GENERATIONS_PATH = '/v1/images/generations';
const GPTIMAGE_EDITS_PATH = '/v1/images/edits';
const GPTIMAGE_DEFAULT_SIZE = '1024x1024';

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

export async function fetchWithAbort(
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

export function getZhipuOfficialApiKey(): string | undefined {
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

/**
 * gpt-image-2 自定义端点配置：env（GPTIMAGE_PROXY_BASE/KEY）优先，再回落 config 槽位。
 * 同 getDashscopeApiKey 范式；base 或 key 任一缺失则返回 undefined。绝不写进代码。
 */
export function getGptImageConfig(): { base: string; key: string } | undefined {
  // SecureStorage slot 名（'gptimage-base' / 'gptimage'）是 Settings UI / 未来配置入口
  // 必须对齐的键名：env GPTIMAGE_PROXY_BASE/_KEY 优先，config slot 是回落。
  // 将来 UI 若用不同键名会导致这里静默读到 undefined，改键名务必两边同步。
  const base = process.env.GPTIMAGE_PROXY_BASE || getConfigService().getApiKey('gptimage-base');
  const key = process.env.GPTIMAGE_PROXY_KEY || getConfigService().getApiKey('gptimage');
  if (!base || !key) return undefined;
  return { base: base.replace(/\/+$/, ''), key };
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

/**
 * 图片 url 下载 SSRF 守卫（D9）：仅放行 https 公网地址，拒绝私网/环回/链路本地/元数据地址。
 * 注意：本守卫基于 hostname 字面量判断，不解析 DNS——可挡 IP 直连与 localhost，
 * 但 DNS rebinding（域名解析到私网）超出本期范围（后续可在 fetch 后校验 socket 远端 IP）。
 */
export function isSafeImageUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost') return false;
  // 私网/环回/链路本地 IPv4
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  // IPv6 字面量——WHATWG URL 的 hostname 保留方括号（如 '[::1]'），必须去括号再判，
  // 且这些前缀检查只能在 IPv6 字面量上跑，否则会误杀以 fc/fd/fe80 开头的公网域名。
  if (h.startsWith('[') && h.endsWith(']')) {
    const h6 = h.slice(1, -1);
    if (h6 === '::1' || h6 === '::') return false;                 // 环回/未指定
    if (h6.startsWith('fc') || h6.startsWith('fd')) return false;  // ULA fc00::/7
    if (h6.startsWith('fe80')) return false;                       // 链路本地
    if (h6.startsWith('::ffff:')) return false;                    // IPv4-mapped——保守整段拒绝，挡映射私网绕过
  }
  return true;
}

export async function downloadImageAsBase64(
  url: string,
  outerSignal: AbortSignal = new AbortController().signal,
): Promise<string> {
  if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的图片 URL（仅允许 https 公网地址）');
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
// 通义万相通用「提交异步任务 → 轮询直到 SUCCEEDED/FAILED → 返回图片 url」。
// 文生图与局部重绘共用（仅 path/body 不同）。
async function submitAndPollWanx(
  apiKey: string,
  apiPath: string,
  body: unknown,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const submitResp = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.dashscope}${apiPath}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-DashScope-Async': 'enable',
      },
      body: JSON.stringify(body),
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

function callWanxImageGeneration(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const size = WANX_SIZE_BY_ASPECT.get(aspectRatio) || '1024*1024';
  return submitAndPollWanx(
    apiKey,
    WANX_T2I_PATH,
    { model: WANX_T2I_MODEL, input: { prompt }, parameters: { size, n: 1 } },
    outerSignal,
  );
}

/**
 * 通义万相局部重绘（inpaint）：base + mask（白=改/黑=留）+ prompt → 只改 mask 区。
 * base/mask 均传 base64 data URI（DashScope 原生接受，无需上传 OSS）。返回结果图 url。
 */
export async function editImageWithMask(input: {
  apiKey: string;
  prompt: string;
  baseImageDataUrl: string;
  maskImageDataUrl: string;
  outerSignal?: AbortSignal;
}): Promise<{ url: string }> {
  return submitAndPollWanx(
    input.apiKey,
    WANX_EDIT_PATH,
    {
      model: WANX_EDIT_MODEL,
      input: {
        function: 'description_edit_with_mask',
        prompt: input.prompt,
        base_image_url: input.baseImageDataUrl,
        mask_image_url: input.maskImageDataUrl,
      },
      parameters: { n: 1 },
    },
    input.outerSignal ?? new AbortController().signal,
  );
}

export type ExpandDirection = 'up' | 'down' | 'left' | 'right' | 'all';

export interface ExpandScales {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function clampExpandScale(value: number): number {
  if (!Number.isFinite(value)) return WANX_EXPAND_SCALE_MIN;
  return Math.min(WANX_EXPAND_SCALE_MAX, Math.max(WANX_EXPAND_SCALE_MIN, value));
}

/**
 * 扩图「方向 + 比例」→ wanx 四向单边 scale（top/bottom/left/right，各 ∈ [1.0, 2.0]）。
 * 单向只抬对应边，'all'(四周) 四边同时按比例外扩。比例越界自动 clamp。
 */
export function expandScalesForDirection(direction: ExpandDirection, ratio: number): ExpandScales {
  const r = clampExpandScale(ratio);
  const base: ExpandScales = { top: 1, bottom: 1, left: 1, right: 1 };
  switch (direction) {
    case 'up':
      return { ...base, top: r };
    case 'down':
      return { ...base, bottom: r };
    case 'left':
      return { ...base, left: r };
    case 'right':
      return { ...base, right: r };
    case 'all':
      return { top: r, bottom: r, left: r, right: r };
    default:
      return base;
  }
}

/**
 * 通义万相扩图（function=expand）：base 图按四向单边 scale 外扩，prompt 描述补绘内容。
 * base 传 base64 data URI（DashScope 原生接受）。返回扩图后的结果图 url（尺寸大于原图）。
 */
export async function expandImage(input: {
  apiKey: string;
  prompt: string;
  baseImageDataUrl: string;
  topScale?: number;
  bottomScale?: number;
  leftScale?: number;
  rightScale?: number;
  outerSignal?: AbortSignal;
}): Promise<{ url: string }> {
  return submitAndPollWanx(
    input.apiKey,
    WANX_EDIT_PATH,
    {
      model: WANX_EDIT_MODEL,
      input: {
        function: 'expand',
        prompt: input.prompt,
        base_image_url: input.baseImageDataUrl,
      },
      parameters: {
        top_scale: clampExpandScale(input.topScale ?? WANX_EXPAND_SCALE_MIN),
        bottom_scale: clampExpandScale(input.bottomScale ?? WANX_EXPAND_SCALE_MIN),
        left_scale: clampExpandScale(input.leftScale ?? WANX_EXPAND_SCALE_MIN),
        right_scale: clampExpandScale(input.rightScale ?? WANX_EXPAND_SCALE_MIN),
        n: 1,
      },
    },
    input.outerSignal ?? new AbortController().signal,
  );
}

/**
 * 通义万相去文字水印（function=remove_watermark）：消除图内中英文文字水印。
 * 无 function 专属参数；prompt API 要求非空但语义不强制，缺省走默认去水印 prompt。
 */
export async function removeWatermark(input: {
  apiKey: string;
  baseImageDataUrl: string;
  prompt?: string;
  outerSignal?: AbortSignal;
}): Promise<{ url: string }> {
  return submitAndPollWanx(
    input.apiKey,
    WANX_EDIT_PATH,
    {
      model: WANX_EDIT_MODEL,
      input: {
        function: 'remove_watermark',
        prompt: input.prompt?.trim() ? input.prompt : DEFAULT_REMOVE_WATERMARK_PROMPT,
        base_image_url: input.baseImageDataUrl,
      },
      parameters: { n: 1 },
    },
    input.outerSignal ?? new AbortController().signal,
  );
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

  if (engine === 'gptimage') {
    const cfg = getGptImageConfig();
    if (!cfg) throw new Error('gpt-image-2 需要在设置配置自定义端点 base 与 API Key。');
    // 设计场景保留文字（gpt-image 强项是文字/UI 渲染），用 raw prompt，不加 NO_TEXT 后缀。
    const resp = await fetchWithAbort(
      `${cfg.base}${GPTIMAGE_GENERATIONS_PATH}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: GPTIMAGE_MODEL, prompt, n: 1, size: GPTIMAGE_DEFAULT_SIZE }),
      },
      TIMEOUT_MS.GPTIMAGE_GENERATION,
      outerSignal,
    );
    if (!resp.ok) {
      // 透出第三方中转返回的错误正文（配额/无效 key/上游超时等唯一可读信号），
      // 与 cogview/wanx 分支一致。body 不含 key（key 只在 Authorization header），安全。
      const errBody = await resp.text().catch(() => '');
      throw new Error(`gpt-image-2 生成失败: ${resp.status}${errBody ? ` - ${errBody}` : ''}`);
    }
    const json = await resp.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) throw new Error('gpt-image-2 返回无 b64_json');
    return { imageData: `data:image/png;base64,${b64}`, actualModel: GPTIMAGE_MODEL };
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

/** dataURL → Blob（multipart 用）。 */
function dataUrlToBlob(dataUrl: string): Blob {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('annotatedImageDataUrl 不是合法 base64 dataURL');
  // 空 base64（如 'data:image/png;base64,'）会过 IPC truthy 校验却产 0 字节图，
  // 在此拦住，避免向付费端点发起空图请求（防 paid no-op）。
  if (!m[2]) throw new Error('annotatedImageDataUrl base64 为空');
  const buf = Buffer.from(m[2], 'base64');
  // Buffer 是 Uint8Array 子类；拷贝成独立 Uint8Array 避免内存池别名。
  return new Blob([new Uint8Array(buf)], { type: m[1] });
}

/**
 * 标注重绘：把 renderer 拍扁的 [原图+标注] 整图喂模型编辑端点。
 * gptimage → OpenAI 兼容 /v1/images/edits（multipart：image+prompt+model）；取 b64。
 * 非 gptimage engine 暂不支持（cap 守门兜底，本期只实装 gpt-image-2）。
 */
export async function editImageByAnnotation(input: {
  engine: ImageEngine;
  annotatedImageDataUrl: string;
  instruction: string;
  outerSignal?: AbortSignal;
}): Promise<{ imageData: string; actualModel: string }> {
  if (input.engine !== 'gptimage') {
    throw new Error(`engine ${input.engine} 暂不支持标注重绘`);
  }
  const cfg = getGptImageConfig();
  if (!cfg) throw new Error('gpt-image-2 需要在设置配置自定义端点 base 与 API Key。');
  const form = new FormData();
  form.append('model', GPTIMAGE_MODEL);
  form.append('prompt', input.instruction);
  form.append('n', '1');
  form.append('size', GPTIMAGE_DEFAULT_SIZE);
  form.append('image', dataUrlToBlob(input.annotatedImageDataUrl), 'annotated.png');
  const resp = await fetchWithAbort(
    `${cfg.base}${GPTIMAGE_EDITS_PATH}`,
    { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form }, // 不设 Content-Type，让 fetch 自带 boundary
    TIMEOUT_MS.GPTIMAGE_GENERATION,
    input.outerSignal ?? new AbortController().signal,
  );
  if (!resp.ok) {
    // 透出第三方中转错误正文（与 generations 分支一致）。body 不含 key（key 只在 Authorization header），安全。
    const errBody = await resp.text().catch(() => '');
    throw new Error(`gpt-image-2 标注重绘失败: ${resp.status}${errBody ? ` - ${errBody}` : ''}`);
  }
  const json = await resp.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-2 标注重绘返回无 b64_json');
  return { imageData: `data:image/png;base64,${b64}`, actualModel: GPTIMAGE_MODEL };
}
