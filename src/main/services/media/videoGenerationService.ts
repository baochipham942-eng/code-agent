// 通义万相视频生成原语（host 可直接调用，剥离 ToolContext/Permission）。
// 复用 wanx「提交异步任务 → 轮询 /tasks 直到 SUCCEEDED/FAILED」骨架，但解析 output.video_url
// （与图像的 output.results[0].url 不同）。t2v / i2v 共用同一提交端点，仅 input/参数不同。
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { getDashscopeApiKey, isSafeImageUrl, fetchWithAbort, WANX_TASKS_PATH } from './imageGenerationService';
import { videoModelById, clampVideoDuration, type VideoCap } from '../../../shared/constants/visualModels';

const VIDEO_SYNTHESIS_PATH = '/services/aigc/video-generation/video-synthesis';
const DEFAULT_RESOLUTION = '720P';

const VIDEO_TIMEOUT_MS = {
  SUBMIT: 30000,
  POLL: 15000,
  POLL_INTERVAL: 5000,
  TOTAL: 600000, // 视频分钟级，给 10min 总超时
  DOWNLOAD: 120000,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析视频任务返回：成功时 url 在 output.video_url（与图像 results[0].url 不同）。 */
export function parseWanxVideoTask(value: unknown): { taskId?: string; status?: string; url?: string; message?: string } {
  if (!isRecord(value)) return {};
  const output = isRecord(value.output) ? value.output : {};
  const taskId = typeof output.task_id === 'string' ? output.task_id : undefined;
  const status = typeof output.task_status === 'string' ? output.task_status : undefined;
  const url = typeof output.video_url === 'string' ? output.video_url : undefined;
  const message =
    typeof output.message === 'string' ? output.message : typeof value.message === 'string' ? value.message : undefined;
  return { taskId, status, url, message };
}

async function submitAndPollWanxVideo(apiKey: string, body: unknown, outerSignal: AbortSignal): Promise<{ url: string }> {
  const submitResp = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.dashscope}${VIDEO_SYNTHESIS_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify(body),
    },
    VIDEO_TIMEOUT_MS.SUBMIT,
    outerSignal,
  );
  if (!submitResp.ok) throw new Error(`通义万相视频提交失败: ${submitResp.status} - ${await submitResp.text()}`);
  const submitted = parseWanxVideoTask(await submitResp.json());
  if (!submitted.taskId) throw new Error('通义万相视频: 未返回 task_id');

  const deadline = Date.now() + VIDEO_TIMEOUT_MS.TOTAL;
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, VIDEO_TIMEOUT_MS.POLL_INTERVAL));
    const pollResp = await fetchWithAbort(
      `${MODEL_API_ENDPOINTS.dashscope}${WANX_TASKS_PATH}/${submitted.taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      VIDEO_TIMEOUT_MS.POLL,
      outerSignal,
    );
    if (!pollResp.ok) continue; // 瞬时失败继续轮询
    const task = parseWanxVideoTask(await pollResp.json());
    if (task.status === 'SUCCEEDED') {
      if (!task.url) throw new Error('通义万相视频: 任务成功但无 video_url');
      return { url: task.url };
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED' || task.status === 'UNKNOWN') {
      throw new Error(`通义万相视频任务失败: ${task.status}${task.message ? ` - ${task.message}` : ''}`);
    }
  }
  throw new Error('通义万相视频任务超时');
}

export interface GenerateVideoArgs {
  model: string;
  mode: VideoCap;
  prompt?: string;
  imageDataUrl?: string;
  durationSec?: number;
  outerSignal?: AbortSignal;
}

export interface GenerateVideoResult {
  url: string;
  actualModel: string;
  durationSec: number;
}

/**
 * 通义万相视频生成：按 model 注册表校验 cap，构造 t2v/i2v body，异步提交+轮询，返回视频 url。
 * 守门顺序（全在付费请求之前）：模型存在 → cap 命中 mode → t2v 需 prompt / i2v 需底图 → key 存在。
 */
export async function generateVideo(args: GenerateVideoArgs): Promise<GenerateVideoResult> {
  const model = videoModelById(args.model);
  if (!model) throw new Error(`未知视频模型 id: ${args.model}`);
  if (!model.caps.includes(args.mode)) throw new Error(`模型 ${args.model} 不支持 ${args.mode}`);
  if (args.mode === 't2v' && !args.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (args.mode === 'i2v' && !args.imageDataUrl) throw new Error('图生视频需要底图');

  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('通义万相视频需要百炼（DashScope）API Key。');

  const durationSec = clampVideoDuration(model, args.durationSec);
  const input: Record<string, unknown> =
    args.mode === 't2v'
      ? { prompt: args.prompt }
      : { img_url: args.imageDataUrl, ...(args.prompt?.trim() ? { prompt: args.prompt } : {}) };

  const { url } = await submitAndPollWanxVideo(
    apiKey,
    { model: model.id, input, parameters: { resolution: DEFAULT_RESOLUTION, duration: durationSec } },
    args.outerSignal ?? new AbortController().signal,
  );
  return { url, actualModel: model.id, durationSec };
}

/** 下载视频到 Buffer（SSRF 守卫复用 image service 的 isSafeImageUrl：仅 https 公网）。 */
export async function downloadVideoAsBuffer(url: string, outerSignal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的视频 URL（仅允许 https 公网地址）');
  const resp = await fetchWithAbort(url, {}, VIDEO_TIMEOUT_MS.DOWNLOAD, outerSignal);
  if (!resp.ok) throw new Error(`视频下载失败: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
