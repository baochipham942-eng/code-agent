// MiniMax 音乐生成原语（host 可直接调用，剥离 ToolContext/Permission）。
// 与图像/视频不同：music_generation 是同步端点（非异步任务），音频以 hex 字符串在
// data.audio 返回（需请求 output_format:hex），解码为 Buffer。成功看 base_resp.status_code===0。
import type { AppSettings } from '../../../shared/contract';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { deriveBridgedVisualModels } from '../../../shared/visualModelBridge';
import { fetchWithAbort, getMinimaxApiKey } from './imageGenerationService';
import { resolveBridgedEndpoint } from './bridgedEndpoint';

const MUSIC_TIMEOUT_MS = { GENERATE: 120000 };

/** 内置 MiniMax 音乐模型 id（无冒号），映射到真实 model 名 music-2.6。 */
const BUILTIN_MINIMAX_MUSIC_ID = 'minimax-music-2.6';

/**
 * 解析音乐模型 id → 端点（baseUrl + apiKey + 真实 modelName）。共享给 IPC handler 与 agent 工具，
 * 与 Spec 1 M1 能力闸对称：
 * - `provider:model`（含冒号）→ deriveBridgedVisualModels 派生音乐能力条目（非音乐能力 id 被挡）
 *   + resolveBridgedEndpoint 取源聊天 provider 端点（key 在 host 内解析，不出 host）。
 * - 内置 minimax-music-2.6 → getMinimaxApiKey + MODEL_API_ENDPOINTS.minimax + modelName music-2.6。
 * - 其余 id → 抛错。缺 key → 抛错（杜绝 paid no-op / 打错端点付费）。
 */
export function resolveMusicModelEndpoint(
  model: string,
  settings: AppSettings | null,
): { baseUrl: string; apiKey: string; modelName: string } {
  if (model?.includes(':')) {
    const entry = deriveBridgedVisualModels(settings).find(
      (m) => m.id === model && m.mediaType === 'music',
    );
    if (!entry) throw new Error(`未知或不支持的桥接音乐模型 ${model}`);
    const { baseUrl, apiKey } = resolveBridgedEndpoint(entry.sourceProvider, settings);
    return { baseUrl, apiKey, modelName: entry.modelName };
  }
  if (model !== BUILTIN_MINIMAX_MUSIC_ID) throw new Error(`未知音乐模型 ${model}`);
  const apiKey = getMinimaxApiKey();
  if (!apiKey) throw new Error('音乐生成需要 MiniMax API Key。');
  return { baseUrl: MODEL_API_ENDPOINTS.minimax, apiKey, modelName: 'music-2.6' };
}

export interface GenerateMusicArgs {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  prompt?: string;
  lyrics?: string;
  outerSignal?: AbortSignal;
}

/**
 * MiniMax 音乐：POST {base}/music_generation（同步）。
 * 音频以 hex 字符串在 data.audio 返回（output_format:hex），解码为 Buffer。成功看 base_resp.status_code===0。
 * 付费前置：prompt 与 lyrics 至少一个非空，否则不发请求。
 */
export async function generateMusic(args: GenerateMusicArgs): Promise<{ audioBuffer: Buffer; actualModel: string }> {
  const hasPrompt = !!args.prompt?.trim();
  const hasLyrics = !!args.lyrics?.trim();
  if (!hasPrompt && !hasLyrics) throw new Error('音乐生成需要 prompt 或 lyrics 至少一项');
  const base = args.baseUrl.replace(/\/+$/, '');
  const signal = args.outerSignal ?? new AbortController().signal;
  const resp = await fetchWithAbort(
    `${base}/music_generation`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: args.modelName,
        ...(hasPrompt ? { prompt: args.prompt } : {}),
        ...(hasLyrics ? { lyrics: args.lyrics } : {}),
        output_format: 'hex',
        audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
      }),
    },
    MUSIC_TIMEOUT_MS.GENERATE,
    signal,
  );
  if (!resp.ok) throw new Error(`音乐生成失败 HTTP ${resp.status}`);
  const body = (await resp.json()) as { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } };
  const code = body.base_resp?.status_code;
  if (typeof code === 'number' && code !== 0) {
    throw new Error(`音乐生成失败：${body.base_resp?.status_msg || code}`);
  }
  const hex = body.data?.audio;
  if (typeof hex !== 'string' || !hex) throw new Error('音乐生成未返回音频数据');
  return { audioBuffer: Buffer.from(hex, 'hex'), actualModel: args.modelName };
}
