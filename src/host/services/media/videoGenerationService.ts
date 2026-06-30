// 通义万相视频生成原语（host 可直接调用，剥离 ToolContext/Permission）。
// 复用 wanx「提交异步任务 → 轮询 /tasks 直到 SUCCEEDED/FAILED」骨架，但解析 output.video_url
// （与图像的 output.results[0].url 不同）。t2v / i2v 共用同一提交端点，仅 input/参数不同。
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { getDashscopeApiKey, getMinimaxApiKey, getMinimaxGroupId, isSafeImageUrl, fetchWithAbort, WANX_TASKS_PATH } from './imageGenerationService';
import { videoModelById, clampVideoDuration, type VideoCap } from '../../../shared/constants/visualModels';
import { pickVideoFlavor, buildPollUrl, extractVideoUrl, isVideoTerminal } from './videoPollFlavors';
import { veoRequest, isGoogleApiUrl } from './veoFetch';

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

// ── P3 通用 OpenAI 兼容视频引擎（POST 建任务 + flavor 注册表轮询） ──
export interface GenerateVideoCompatArgs {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  mode: 't2v' | 'i2v';
  prompt?: string;
  imageDataUrl?: string;
  width?: number;
  height?: number;
  numFrames?: number;
  frameRate?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** 建任务请求超时（ms）。第三方网关的异步 create 可能很慢（实测 Agnes 免费档 create 排队 ~90s），
   *  故 compat 路径不用内置 wanx/minimax 共享的 30s SUBMIT，默认放宽到 120s。 */
  createTimeoutMs?: number;
  outerSignal?: AbortSignal;
}

const COMPAT_VIDEO_DEFAULTS = { pollIntervalMs: 8000, maxPolls: 60, createTimeoutMs: 120000, width: 1152, height: 768, numFrames: 121, frameRate: 24 };

/**
 * 通用 OpenAI 兼容视频：POST {base}/videos 建任务 → flavor 注册表轮询 → 取 url。
 * 守门顺序全在付费请求之前：t2v 需非空 prompt / i2v 需底图 → 建任务失败不进轮询。
 * 沿用本文件 fetchWithAbort（超时 + outerSignal）与 redirect:'manual'（防 SSRF-via-redirect）。
 */
export async function generateVideoOpenAICompat(args: GenerateVideoCompatArgs): Promise<{ url: string; actualModel: string }> {
  if (args.mode === 't2v' && !args.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (args.mode === 'i2v' && !args.imageDataUrl) throw new Error('图生视频需要底图');
  const base = args.baseUrl.replace(/\/+$/, '');
  const flavor = pickVideoFlavor(args.baseUrl);
  const signal = args.outerSignal ?? new AbortController().signal;

  const body: Record<string, unknown> = {
    model: args.modelName,
    prompt: args.prompt,
    width: args.width ?? COMPAT_VIDEO_DEFAULTS.width,
    height: args.height ?? COMPAT_VIDEO_DEFAULTS.height,
    num_frames: args.numFrames ?? COMPAT_VIDEO_DEFAULTS.numFrames,
    frame_rate: args.frameRate ?? COMPAT_VIDEO_DEFAULTS.frameRate,
    ...(args.mode === 'i2v' && args.imageDataUrl ? { image: args.imageDataUrl } : {}),
  };
  const createRes = await fetchWithAbort(
    `${base}/videos`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    // 第三方网关异步 create 可能 ~90s（dogfood：Agnes 免费档 create 排队 89s 才返 queued）；
    // 用 compat 专属放宽超时，避免慢但正常的 create 被 30s 误杀。
    args.createTimeoutMs ?? COMPAT_VIDEO_DEFAULTS.createTimeoutMs,
    signal,
  );
  if (!createRes.ok) throw new Error(`视频建任务失败 HTTP ${createRes.status}`);
  const created = (await createRes.json()) as Record<string, unknown>;
  const id = (created.video_id || created.id || created.task_id) as string | undefined;
  if (!id) throw new Error('视频建任务未返回 id');

  const interval = args.pollIntervalMs ?? COMPAT_VIDEO_DEFAULTS.pollIntervalMs;
  const maxPolls = args.maxPolls ?? COMPAT_VIDEO_DEFAULTS.maxPolls;
  for (let i = 0; i < maxPolls; i++) {
    if (signal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetchWithAbort(
      buildPollUrl(flavor, args.baseUrl, id),
      { method: 'GET', redirect: 'manual', headers: { Authorization: `Bearer ${args.apiKey}` } },
      VIDEO_TIMEOUT_MS.POLL,
      signal,
    );
    if (!pollRes.ok) continue; // 瞬时失败继续轮询
    const polled = (await pollRes.json()) as Record<string, unknown>;
    const { done, failed } = isVideoTerminal(typeof polled.status === 'string' ? polled.status : undefined);
    if (failed) throw new Error(`视频生成失败：${polled.error || polled.status}`);
    if (done) {
      const url = extractVideoUrl(flavor, polled);
      if (url) return { url, actualModel: args.modelName };
      throw new Error('视频完成但未取到 URL');
    }
  }
  throw new Error('视频生成轮询超时');
}

/** 下载视频到 Buffer（SSRF 守卫复用 image service 的 isSafeImageUrl：仅 https 公网）。 */
export async function downloadVideoAsBuffer(url: string, outerSignal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的视频 URL（仅允许 https 公网地址）');
  // SSRF-via-redirect 防护：isSafeImageUrl 只校验初始 url；若让 fetch 透明跟 3xx 跳转，
  // 端点可把视频 url 跳到 169.254.169.254 等私网绕过守卫。用 redirect:manual 截停并拒绝跳转
  // （与姊妹函数 downloadImageAsBase64 对齐，合法视频直出 200，不靠跳转）。
  const resp = await fetchWithAbort(url, { redirect: 'manual' }, VIDEO_TIMEOUT_MS.DOWNLOAD, outerSignal);
  if (resp.status >= 300 && resp.status < 400) throw new Error(`拒绝跟随视频下载重定向（${resp.status}）`);
  if (!resp.ok) throw new Error(`视频下载失败: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ── Veo 原生（Spec 3，Google Gemini API 轻路径） ──────────────────────────────
// 契约：POST {gemini}/models/{model}:predictLongRunning → 轮询 GET {gemini}/{operation.name}
// 直到 done:true → 取 generateVideoResponse 里视频 uri → 鉴权下载。全程经代理（veoFetch）。
const VEO_TIMEOUT_MS = {
  CREATE: 120000,
  POLL: 30000,
  POLL_INTERVAL: 10000,
  TOTAL: 360000,
  DOWNLOAD: 120000,
};

/** 从完成响应抽取视频 URI。优先 generatedSamples（Veo 2 路径），兜底 generatedVideos（3.1 可能改名）。
 *  ⚠️ 字段路径为文档最佳已知值，首次付费 dogfood 前须对照真响应/SDK 确证。 */
export function extractVeoVideoUri(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const gvr = isRecord(response.generateVideoResponse) ? response.generateVideoResponse : undefined;
  if (!gvr) return undefined;
  const samples = Array.isArray(gvr.generatedSamples)
    ? gvr.generatedSamples
    : Array.isArray(gvr.generatedVideos)
      ? gvr.generatedVideos
      : undefined;
  const first = samples && samples.length > 0 ? samples[0] : undefined;
  const video = isRecord(first) && isRecord(first.video) ? first.video : undefined;
  return video && typeof video.uri === 'string' ? video.uri : undefined;
}

/** 解析 data URL → { base64, mimeType }。非法 data URL 抛错。 */
function parseImageDataUrl(dataUrl: string): { base64: string; mimeType: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('底图不是合法 data URL');
  return { mimeType: m[1], base64: m[2] };
}

async function submitAndPollVeoOperation(
  model: string,
  apiKey: string,
  instances: Record<string, unknown>[],
  parameters: Record<string, unknown>,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<{ uri: string }> {
  const base = MODEL_API_ENDPOINTS.gemini;
  const createResp = await veoRequest(`${base}/models/${model}:predictLongRunning`, {
    method: 'POST', apiKey, body: { instances, parameters }, timeoutMs: VEO_TIMEOUT_MS.CREATE, signal,
  });
  if (!createResp.ok) throw new Error(`Veo 建任务失败 HTTP ${createResp.status}`);
  const opName = isRecord(createResp.data) && typeof createResp.data.name === 'string' ? createResp.data.name : '';
  if (!opName) throw new Error('Veo 建任务未返回 operation name');

  const deadline = Date.now() + VEO_TIMEOUT_MS.TOTAL;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    const pollResp = await veoRequest(`${base}/${opName}`, { method: 'GET', apiKey, timeoutMs: VEO_TIMEOUT_MS.POLL, signal });
    if (!pollResp.ok) continue;
    const data = pollResp.data;
    if (isRecord(data) && data.done === true) {
      if (isRecord(data.error)) {
        const msg = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
        throw new Error(`Veo 任务失败: ${msg}`);
      }
      const uri = extractVeoVideoUri(data.response);
      if (!uri) throw new Error('Veo 任务完成但未取到视频 URI');
      return { uri };
    }
  }
  throw new Error('Veo 任务超时');
}

/** 鉴权 + 代理下载 Veo 视频文件（Google host 白名单自守 + 拒 3xx 跳转）。 */
export async function downloadVeoFile(uri: string, apiKey: string, signal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  if (!isGoogleApiUrl(uri)) throw new Error('拒绝下载非 Google 域的 Veo 视频 URI');
  const resp = await veoRequest(uri, { method: 'GET', apiKey, responseType: 'arraybuffer', timeoutMs: VEO_TIMEOUT_MS.DOWNLOAD, signal });
  if (resp.status >= 300 && resp.status < 400) throw new Error(`拒绝跟随 Veo 下载重定向（${resp.status}）`);
  if (!resp.ok || !resp.buffer) throw new Error(`Veo 视频下载失败: ${resp.status}`);
  return resp.buffer;
}

export interface GenerateVeoVideoArgs {
  model: string;
  mode: 't2v' | 'i2v';
  prompt?: string;
  imageDataUrl?: string;
  durationSec?: number;
  outerSignal?: AbortSignal;
  /** 测试用：缩短轮询间隔。生产不传，用 VEO_TIMEOUT_MS.POLL_INTERVAL。 */
  pollIntervalMsOverride?: number;
}

/**
 * Veo 原生视频生成：注册表校验 → 守门（cap/prompt/底图/key 全在付费前）→ 提交+轮询+鉴权下载。
 * 返回已下载的 Buffer（与 dashscope/minimax 的 url 返回不同——Veo 下载需鉴权+代理，不走公共 downloadVideoAsBuffer）。
 */
export async function generateVeoVideo(args: GenerateVeoVideoArgs): Promise<{ buffer: Buffer; actualModel: string; durationSec: number }> {
  const model = videoModelById(args.model);
  if (!model) throw new Error(`未知视频模型 id: ${args.model}`);
  if (model.provider !== 'google') throw new Error(`模型 ${args.model} 不是 Veo（google）模型`);
  if (!model.caps.includes(args.mode)) throw new Error(`模型 ${args.model} 不支持 ${args.mode}`);
  if (args.mode === 't2v' && !args.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (args.mode === 'i2v' && !args.imageDataUrl) throw new Error('图生视频需要底图');

  const { getGeminiApiKey } = await import('./imageGenerationService');
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('Veo 视频需要 Gemini（付费档）API Key。');

  const durationSec = clampVideoDuration(model, args.durationSec);
  const signal = args.outerSignal ?? new AbortController().signal;

  const instances: Record<string, unknown>[] = [{ prompt: args.prompt }];
  if (args.mode === 'i2v' && args.imageDataUrl) {
    const { base64, mimeType } = parseImageDataUrl(args.imageDataUrl);
    instances[0].image = { bytesBase64Encoded: base64, mimeType };
  }
  const parameters: Record<string, unknown> = { aspectRatio: '16:9' };

  const { uri } = await submitAndPollVeoOperation(
    model.id, apiKey, instances, parameters, signal, args.pollIntervalMsOverride ?? VEO_TIMEOUT_MS.POLL_INTERVAL,
  );
  const buffer = await downloadVeoFile(uri, apiKey, signal);
  return { buffer, actualModel: model.id, durationSec };
}
