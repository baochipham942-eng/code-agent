// ============================================================================
// Brand Extract（从参考图提取品牌草稿 · CD-Parity §1 B2）—— vision 一次性抽取
// ----------------------------------------------------------------------------
// OpenDesign reference-design-contract 式：参考图 → vision 模型抽出
//   { tokens(DirectionTokens 形状, best-effort) + keep/change/doNotCopy 三桶 }
// 这是一份 DRAFT（不校验成完整 BrandContract）：回到 renderer 预填手填表单，由用户
// 审改 + 命名后经现成 saveBrand 落盘（human-in-loop 防 slop），本模块**不落盘、不自动保存**。
//
// 视觉调用复用 imageAnalyze 完全相同的模型/Key 解析：ModelRouter +
// getVisionPreflightCandidates（用户已配 Key 的识图模型，同 provider 优先）→ 兜底
// 智谱 GLM-V / OpenRouter Gemini。付费一次（vision），调用方须提示成本。
//
// 纯解析逻辑（parseBrandDraftJson / JSON 抽取 / 默认兜底）与 IO 分离，可单测；
// vision 调用经可注入的 visionCall 钩子（测试传 canned JSON，绝不真调）。
// ============================================================================

import fsPromises from 'fs/promises';
import * as path from 'path';
import { getConfigService } from '../../services';
import {
  MODEL_API_ENDPOINTS,
  ZHIPU_VISION_MODEL,
  MODEL_MAX_TOKENS,
  DEFAULT_PROVIDER,
  DEFAULT_MODELS,
} from '../../../shared/constants';
import { ModelRouter } from '../../model/modelRouter';
import type { ModelConfig, ModelProvider } from '../../../shared/contract/model';
import type { ModelMessage } from '../../model/types';
import { normalizeStringList } from '../../../shared/contract/designBrief';
import { directionTokens, type DirectionTokens } from '../../../design/direction-tokens';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const TIMEOUT_MS = 30000;
// 默认兜底 tokens：模型未给/给坏时填，保证 5 色 + serif/sans + posture 都非空。
const DEFAULT_TOKENS: DirectionTokens = directionTokens.utilitarian;

/** B2 抽取产物：DRAFT（best-effort），非完整校验的 BrandContract。 */
export interface BrandDraft {
  tokens: DirectionTokens;
  keep: string[];
  change: string[];
  doNotCopy: string[];
}

/** vision 一次性调用的入参（renderer 传 dataUrl，CLI/IPC 也可传设计目录内 imagePath）。 */
export interface BrandExtractInput {
  /** base64 data URL（data:image/png;base64,...）。 */
  dataUrl?: string;
  /** 已读到内存的图片字节（与 dataUrl/imagePath 三选一）。 */
  imageBytes?: Buffer;
  mimeType?: string;
  /** 绝对路径（IPC 侧已过 assertWithinDesignDir）。 */
  imagePath?: string;
}

/** 可注入的 vision 调用钩子（测试传 canned JSON，避免真调付费模型）。 */
export type VisionCallFn = (base64Image: string, mimeType: string, prompt: string) => Promise<string>;

export interface BrandExtractOptions {
  visionCall?: VisionCallFn;
  signal?: AbortSignal;
}

// ----------------------------------------------------------------------------
// 提取 prompt：指示模型严格返回 JSON（5 色 hex/oklch + serif/sans + 一句 posture +
// 三桶短 bullet）。明确「只返回 JSON」，但解析层仍对围栏/散文鲁棒（模型不一定听话）。
// ----------------------------------------------------------------------------
export const BRAND_EXTRACT_PROMPT = [
  '你是一名资深品牌设计师。分析这张参考设计图的视觉语言，提取一份「品牌契约草稿」。',
  '',
  '只返回一个 JSON 对象，不要任何解释或 markdown 围栏，结构严格如下：',
  '{',
  '  "palette": {',
  '    "primary":  "主色（hex 或 oklch）",',
  '    "surface":  "背景/底色",',
  '    "accent":   "强调色",',
  '    "muted":    "次要/弱化色",',
  '    "contrast": "正文/高对比色"',
  '  },',
  '  "fonts": {',
  '    "serif": "一个合理的衬线字体栈猜测，如 Tiempos, Georgia, serif",',
  '    "sans":  "一个合理的无衬线字体栈猜测，如 Inter, system-ui, sans-serif"',
  '  },',
  '  "posture": "一句话描述这个设计的气质/调性",',
  '  "keep":      ["必须复刻的设计语言要点，2-4 条短句"],',
  '  "change":    ["可以调整/浮动的部分，0-3 条短句"],',
  '  "doNotCopy": ["应当避免的反模式，1-3 条短句"]',
  '}',
  '',
  '颜色尽量贴近图中真实取值。keep/change/doNotCopy 用中文短句，描述这张参考图的设计语言。',
].join('\n');

// ----------------------------------------------------------------------------
// JSON 抽取：容忍 ```json 围栏 / 前后散文 / 裸 JSON。返回第一个能解析成对象的片段。
// ----------------------------------------------------------------------------
function extractJsonObject(text: string): unknown {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1) 直接整体解析
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallthrough
  }

  // 2) ```json ... ``` 或 ``` ... ``` 围栏内
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fallthrough
    }
  }

  // 3) 第一个 { 到最后一个 } 的子串（散文包裹时兜底）
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fallthrough
    }
  }
  return null;
}

function asText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function asBucket(value: unknown): string[] {
  return normalizeStringList(value) ?? [];
}

/**
 * 把模型返回的（可能带围栏/散文/缺字段）文本解析成 BrandDraft。
 * - 容忍 ```json 围栏与多余散文；
 * - 每个缺失/非法的 palette 槽、fonts、posture 从默认 tokens 兜底（保证形状完整）；
 * - 三桶非数组/含空项 → 归一为去空去重数组（缺则 []）；
 * - 任何情况都不抛，返回 best-effort DRAFT。
 * 纯函数，可单测。
 */
export function parseBrandDraftJson(text: string): BrandDraft {
  const parsed = extractJsonObject(text);
  const obj = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as Record<string, unknown>)
    : {};

  const paletteRaw = (obj.palette && typeof obj.palette === 'object' && !Array.isArray(obj.palette))
    ? (obj.palette as Record<string, unknown>)
    : {};
  const fontsRaw = (obj.fonts && typeof obj.fonts === 'object' && !Array.isArray(obj.fonts))
    ? (obj.fonts as Record<string, unknown>)
    : {};

  const tokens: DirectionTokens = {
    palette: {
      primary: asText(paletteRaw.primary, DEFAULT_TOKENS.palette.primary),
      surface: asText(paletteRaw.surface, DEFAULT_TOKENS.palette.surface),
      accent: asText(paletteRaw.accent, DEFAULT_TOKENS.palette.accent),
      muted: asText(paletteRaw.muted, DEFAULT_TOKENS.palette.muted),
      contrast: asText(paletteRaw.contrast, DEFAULT_TOKENS.palette.contrast),
    },
    fonts: {
      serif: asText(fontsRaw.serif, DEFAULT_TOKENS.fonts.serif),
      sans: asText(fontsRaw.sans, DEFAULT_TOKENS.fonts.sans),
    },
    posture: asText(obj.posture, DEFAULT_TOKENS.posture),
    // refs 留空：参考图来源（reference.png）由 registry 落盘留档，draft 不带灵感样本名。
    refs: [],
  };

  return {
    tokens,
    keep: asBucket(obj.keep),
    change: asBucket(obj.change),
    doNotCopy: asBucket(obj.doNotCopy),
  };
}

// ----------------------------------------------------------------------------
// 真实 vision 调用：与 imageAnalyze 同款解析（ModelRouter 已配 Key 识图模型优先 →
// 智谱 GLM-V → OpenRouter Gemini）。第一个产出非空文本即返回。
// ----------------------------------------------------------------------------
async function defaultVisionCall(
  base64Image: string,
  mimeType: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const router = new ModelRouter();
  const baseConfig: ModelConfig = {
    provider: DEFAULT_PROVIDER as ModelProvider,
    model: DEFAULT_MODELS.chat,
    maxTokens: MODEL_MAX_TOKENS.VISION,
  };
  const candidates = router.getVisionPreflightCandidates(baseConfig);

  // 1) 用户已配置识图模型（mimo-omni / claude vision 等）
  for (const cfg of candidates) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          ],
        },
      ];
      const resp = await router.inference(
        messages,
        [],
        { ...cfg, adaptive: false, maxTokens: Math.min(cfg.maxTokens || MODEL_MAX_TOKENS.VISION, 2048) },
        undefined,
        signal,
      );
      const content = typeof resp.content === 'string' ? resp.content.trim() : '';
      if (content) return content;
    } catch {
      // 尝试下一个候选
    }
  }

  // 2) 兜底：智谱 GLM-V → OpenRouter Gemini（仅当配了对应 Key）
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');
  if (zhipuApiKey) {
    try {
      return await callZhipuVision(zhipuApiKey, base64Image, mimeType, prompt, signal);
    } catch {
      // fallthrough
    }
  }
  const openrouterApiKey = configService.getApiKey('openrouter');
  if (openrouterApiKey) {
    try {
      return await callOpenRouterVision(openrouterApiKey, base64Image, mimeType, prompt, signal);
    } catch {
      // fallthrough
    }
  }

  throw new Error(
    '从参考图提取需要视觉模型，但没有可用的识图模型。请在模型设置里配置任一支持视觉的 provider（小米 MiMo Omni / Claude 视觉 / 智谱 GLM-V / OpenRouter 视觉）后重试。',
  );
}

async function fetchVision(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`视觉 API 错误: ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() || '';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function visionBody(model: string, base64Image: string, mimeType: string, prompt: string) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    max_tokens: MODEL_MAX_TOKENS.VISION,
  };
}

function callZhipuVision(apiKey: string, base64Image: string, mimeType: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return fetchVision(
    `${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`,
    apiKey,
    visionBody(ZHIPU_VISION_MODEL, base64Image, mimeType, prompt),
    signal,
  );
}

function callOpenRouterVision(apiKey: string, base64Image: string, mimeType: string, prompt: string, signal?: AbortSignal): Promise<string> {
  return fetchVision(
    `${MODEL_API_ENDPOINTS.openrouter}/chat/completions`,
    apiKey,
    visionBody('google/gemini-2.0-flash-001', base64Image, mimeType, prompt),
    signal,
  );
}

// ----------------------------------------------------------------------------
// 把入参（dataUrl / imageBytes / imagePath）归一成 { base64, mimeType }。
// ----------------------------------------------------------------------------
async function resolveImage(input: BrandExtractInput): Promise<{ base64: string; mimeType: string }> {
  if (input.dataUrl) {
    const m = input.dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) throw new Error('extractBrandFromImage: dataUrl 格式非法');
    return { mimeType: m[1], base64: m[2] };
  }
  if (input.imageBytes) {
    return { base64: input.imageBytes.toString('base64'), mimeType: input.mimeType || 'image/png' };
  }
  if (input.imagePath) {
    const bytes = await fsPromises.readFile(input.imagePath);
    const ext = path.extname(input.imagePath).toLowerCase();
    return { base64: bytes.toString('base64'), mimeType: MIME_TYPES[ext] || 'image/png' };
  }
  throw new Error('extractBrandFromImage 需要 dataUrl / imageBytes / imagePath 之一');
}

/**
 * 从参考图一次性抽取一份 BrandDraft（vision，付费一次）。
 * 不落盘、不自动保存——返回给 renderer 预填手填表单，由用户审改命名后走 saveBrand。
 */
export async function extractBrandFromImage(
  input: BrandExtractInput,
  options: BrandExtractOptions = {},
): Promise<BrandDraft> {
  const { base64, mimeType } = await resolveImage(input);
  const call: VisionCallFn = options.visionCall
    ?? ((b, m, p) => defaultVisionCall(b, m, p, options.signal));
  const raw = await call(base64, mimeType, BRAND_EXTRACT_PROMPT);
  return parseBrandDraftJson(raw);
}
