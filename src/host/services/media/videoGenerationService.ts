// 通义万相视频生成原语（host 可直接调用，剥离 ToolContext/Permission）。
// 复用 wanx「提交异步任务 → 轮询 /tasks 直到 SUCCEEDED/FAILED」骨架，但解析 output.video_url
// （与图像的 output.results[0].url 不同）。t2v / i2v 共用同一提交端点，仅 input/参数不同。
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { getDashscopeApiKey, getMinimaxApiKey, getMinimaxGroupId, getArkApiKey, isSafeImageUrl, fetchWithAbort, WANX_TASKS_PATH } from './imageGenerationService';
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
  // 提交即终态（如内容审核 FAILED）：直接抛出 message，不进入轮询（省一次无谓往返）。
  if (submitted.status && submitted.status !== 'PENDING' && submitted.status !== 'RUNNING') {
    if (submitted.status === 'SUCCEEDED' && submitted.url) return { url: submitted.url };
    throw new Error(`通义万相视频任务失败: ${submitted.status}${submitted.message ? ` - ${submitted.message}` : ''}`);
  }
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

// ── P3 MiniMax 海螺视频（端点/契约经免费探针核实，与 wanx 异：submit→query→files/retrieve 三步） ──
const MINIMAX_SUBMIT_PATH = '/video_generation';
const MINIMAX_QUERY_PATH = '/query/video_generation';
const MINIMAX_RETRIEVE_PATH = '/files/retrieve';

function parseMinimaxBaseResp(value: unknown): { code?: number; msg?: string } {
  if (!isRecord(value) || !isRecord(value.base_resp)) return {};
  const br = value.base_resp;
  return {
    code: typeof br.status_code === 'number' ? br.status_code : undefined,
    msg: typeof br.status_msg === 'string' ? br.status_msg : undefined,
  };
}

/** 海螺 submit→query→retrieve：提交拿 task_id，轮询拿 file_id(status=Success)，retrieve 拿 download_url。 */
async function submitAndPollMinimaxVideo(
  apiKey: string,
  body: Record<string, unknown>,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const base = MODEL_API_ENDPOINTS.minimax;
  const authHeaders = { Authorization: `Bearer ${apiKey}` };
  const submitResp = await fetchWithAbort(
    `${base}${MINIMAX_SUBMIT_PATH}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(body) },
    VIDEO_TIMEOUT_MS.SUBMIT,
    outerSignal,
  );
  if (!submitResp.ok) throw new Error(`海螺视频提交失败: ${submitResp.status} - ${await submitResp.text()}`);
  const submitJson: unknown = await submitResp.json();
  const sr = parseMinimaxBaseResp(submitJson);
  if (sr.code !== undefined && sr.code !== 0) throw new Error(`海螺视频提交失败: ${sr.code} - ${sr.msg ?? ''}`);
  const taskId = isRecord(submitJson) && typeof submitJson.task_id === 'string' ? submitJson.task_id : '';
  if (!taskId) throw new Error('海螺视频: 未返回 task_id');

  const deadline = Date.now() + VIDEO_TIMEOUT_MS.TOTAL;
  let fileId = '';
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, VIDEO_TIMEOUT_MS.POLL_INTERVAL));
    const q = await fetchWithAbort(
      `${base}${MINIMAX_QUERY_PATH}?task_id=${encodeURIComponent(taskId)}`,
      { headers: authHeaders },
      VIDEO_TIMEOUT_MS.POLL,
      outerSignal,
    );
    if (!q.ok) continue; // 瞬时失败继续轮询
    const qj: unknown = await q.json();
    const status = isRecord(qj) && typeof qj.status === 'string' ? qj.status : '';
    if (status === 'Success') {
      fileId = isRecord(qj) && typeof qj.file_id === 'string' ? qj.file_id : '';
      break;
    }
    if (status === 'Fail') {
      const qr = parseMinimaxBaseResp(qj);
      throw new Error(`海螺视频任务失败: ${qr.msg ?? 'Fail'}`);
    }
    // Queueing / Preparing / Processing → 继续轮询
  }
  if (!fileId) throw new Error('海螺视频任务超时或无 file_id');

  // file_id → download_url。MiniMax files/retrieve 需 GroupId（团队 ID）作 query 参数，有则带上。
  const groupId = getMinimaxGroupId();
  const retrieveUrl =
    `${base}${MINIMAX_RETRIEVE_PATH}?file_id=${encodeURIComponent(fileId)}` +
    (groupId ? `&GroupId=${encodeURIComponent(groupId)}` : '');
  const r = await fetchWithAbort(retrieveUrl, { headers: authHeaders }, VIDEO_TIMEOUT_MS.POLL, outerSignal);
  if (!r.ok) throw new Error(`海螺视频取文件失败: ${r.status} - ${await r.text()}`);
  const rj: unknown = await r.json();
  const url =
    isRecord(rj) && isRecord(rj.file) && typeof rj.file.download_url === 'string' ? rj.file.download_url : '';
  if (!url) {
    const rr = parseMinimaxBaseResp(rj);
    throw new Error(`海螺视频: 取文件无 download_url${rr.msg ? ` - ${rr.msg}` : ''}`);
  }
  return { url };
}

// ── Spec 2 Seedance 原生（火山方舟 Ark · 异步任务 contents/generations/tasks） ──
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_TASKS_PATH = '/contents/generations/tasks';
const ARK_CREATE_TIMEOUT_MS = 120000; // 异步建任务可能慢，仿 compat 放宽（不动共享 SUBMIT 30s）
const ARK_DEFAULT_RESOLUTION = '720p';
const ARK_DEFAULT_RATIO = '16:9';

export interface ArkVideoArgs {
  model: string;
  mode: 't2v' | 'i2v';
  prompt?: string;
  imageDataUrl?: string;
  durationSec: number;
  resolution?: string;
  ratio?: string;
}

/** 解析 Ark 任务返回：建任务态有 id；轮询态有 status + content.video_url。 */
export function parseArkVideoTask(value: unknown): { id?: string; status?: string; url?: string; message?: string } {
  if (!isRecord(value)) return {};
  const id = typeof value.id === 'string' ? value.id : undefined;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const content = isRecord(value.content) ? value.content : {};
  const url = typeof content.video_url === 'string' ? content.video_url : undefined;
  const err = isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : undefined;
  const message = err ?? (typeof value.message === 'string' ? value.message : undefined);
  return { id, status, url, message };
}

/**
 * Seedance 原生出片：POST 建任务 → 轮询 status=succeeded → 取 content.video_url。
 * 守门（t2v 需 prompt / i2v 需底图）由上游 generateVideo 统一做；此处只编排请求。
 * 火山返回 URL 24h 过期，调用方须立刻 downloadVideoAsBuffer 落 artifact。
 */
export async function submitAndPollArkVideo(
  apiKey: string,
  args: ArkVideoArgs,
  outerSignal: AbortSignal,
  opts?: { pollIntervalMs?: number },
): Promise<{ url: string }> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: args.prompt ?? '' }];
  if (args.mode === 'i2v' && args.imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: args.imageDataUrl } });
  }
  const body = {
    model: args.model,
    content,
    resolution: args.resolution ?? ARK_DEFAULT_RESOLUTION,
    ratio: args.ratio ?? ARK_DEFAULT_RATIO,
    duration: args.durationSec,
    watermark: false,
  };

  const createRes = await fetchWithAbort(
    `${ARK_BASE}${ARK_TASKS_PATH}`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    ARK_CREATE_TIMEOUT_MS,
    outerSignal,
  );
  if (!createRes.ok) throw new Error(`Seedance 视频建任务失败: ${createRes.status} - ${await createRes.text()}`);
  const created = parseArkVideoTask(await createRes.json());
  if (!created.id) throw new Error('Seedance 视频: 未返回 task id');

  const interval = opts?.pollIntervalMs ?? VIDEO_TIMEOUT_MS.POLL_INTERVAL;
  const deadline = Date.now() + VIDEO_TIMEOUT_MS.TOTAL;
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetchWithAbort(
      `${ARK_BASE}${ARK_TASKS_PATH}/${encodeURIComponent(created.id)}`,
      { redirect: 'manual', headers: { Authorization: `Bearer ${apiKey}` } },
      VIDEO_TIMEOUT_MS.POLL,
      outerSignal,
    );
    if (!pollRes.ok) continue; // 瞬时失败继续轮询
    const task = parseArkVideoTask(await pollRes.json());
    if (task.status === 'succeeded') {
      if (!task.url) throw new Error('Seedance 视频: 任务成功但无 content.video_url');
      return { url: task.url };
    }
    if (task.status === 'failed' || task.status === 'expired' || task.status === 'cancelled') {
      throw new Error(`Seedance 视频任务失败: ${task.status}${task.message ? ` - ${task.message}` : ''}`);
    }
    // queued / running → 继续轮询
  }
  throw new Error('Seedance 视频任务超时');
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

  const durationSec = clampVideoDuration(model, args.durationSec);
  const signal = args.outerSignal ?? new AbortController().signal;

  // 按 provider 路由：dashscope=通义万相（output.video_url）/ minimax=海螺（三步 retrieve）。
  if (model.provider === 'minimax') {
    const apiKey = getMinimaxApiKey();
    if (!apiKey) throw new Error('海螺视频需要 MiniMax API Key。');
    // 海螺 MVP 不传 duration（用模型默认 6s）；i2v 底图走 first_frame_image（探针确认字段名）。
    const body: Record<string, unknown> =
      args.mode === 't2v'
        ? { model: model.id, prompt: args.prompt }
        : { model: model.id, first_frame_image: args.imageDataUrl, ...(args.prompt?.trim() ? { prompt: args.prompt } : {}) };
    const { url } = await submitAndPollMinimaxVideo(apiKey, body, signal);
    return { url, actualModel: model.id, durationSec };
  }

  // Spec 2：Seedance 原生（火山方舟 Ark）。守门已在上方统一做（cap / prompt / 底图）。
  if (model.provider === 'ark') {
    const apiKey = getArkApiKey();
    if (!apiKey) throw new Error('Seedance 视频需要火山方舟 Ark API Key（在 火山引擎/豆包 provider 配置）。');
    const { url } = await submitAndPollArkVideo(
      apiKey,
      { model: model.id, mode: args.mode, prompt: args.prompt, imageDataUrl: args.imageDataUrl, durationSec },
      signal,
    );
    return { url, actualModel: model.id, durationSec };
  }

  // dashscope（通义万相）
  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('通义万相视频需要百炼（DashScope）API Key。');
  const input: Record<string, unknown> =
    args.mode === 't2v'
      ? { prompt: args.prompt }
      : { img_url: args.imageDataUrl, ...(args.prompt?.trim() ? { prompt: args.prompt } : {}) };
  const { url } = await submitAndPollWanxVideo(
    apiKey,
    { model: model.id, input, parameters: { resolution: DEFAULT_RESOLUTION, duration: durationSec } },
    signal,
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
