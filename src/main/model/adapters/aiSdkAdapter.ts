// ============================================================================
// AI SDK Adapter — 用 Vercel AI SDK 归一 provider 工具调用，替代手写解析。
//
// 实现与 ModelRouter.inference 相同的契约：
//   (messages, tools, config, onStream?, signal?, options?) => Promise<ModelResponse>
// 单步推理（不设 stopWhen）——Neo 自己驱动 agent loop + 执行工具，所以这里只要把
// 模型这一轮的 text/tool-call 归一返回。
//
// 两条路径：
//   - 非流式（onStream 缺省 或 options.forceNonStreaming）：用 generateText。
//     服务子代理（onStream no-op）和主 loop 的 artifact 非流式重试。
//   - 流式（onStream 存在）：用 streamText 消费 fullStream，把事件映射成项目的
//     StreamCallback 契约（StreamChunk，见 model/types.ts）后实时回调，最终从流里
//     累积出与非流式同形状的 ModelResponse。服务主 agent loop 的逐字输出。
//     映射目标对齐旧 SSE 路径 providers/sseStream.ts（openAISSEStream），不自创语义。
//
// 收益：DeepSeek 非流式不再漏 <｜｜DSML｜｜>（SDK 层归一）；工具名经 tool() 单一
// 定义，无 snake_case/PascalCase 漂移（对照 Bug B / Bug C）。
// ============================================================================

import { generateText, streamText, jsonSchema, tool as aiTool } from 'ai';
import type { LanguageModel, ModelMessage as AiModelMessage, ToolSet, TextStreamPart } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import axios, { type AxiosResponse } from 'axios';
import { Readable, Transform } from 'node:stream';
import type {
  ModelMessage,
  MessageContent,
  StreamCallback,
  ResponseContentPart,
  InferenceOptions,
} from '../types';
import type { StreamSnapshot } from '../providers/sseStream';
import type { ModelResponse } from '../../agent/loopTypes';
import type { ToolCall, ToolDefinition, ModelConfig } from '../../../shared/contract';
import { MODEL_API_ENDPOINTS, PROVIDER_TIMEOUT, SSE_FIRST_BYTE_TIMEOUT, SSE_INACTIVITY_TIMEOUT } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';
import { PROVIDER_REGISTRY } from '../providerRegistry';
import { resolveProviderBaseUrl, resolveProviderApiKey } from '../providers/providerResolution';
import { withTransientRetry, isTransientError } from '../providers/retryStrategy';
import { getProviderHealthMonitor } from '../providerHealthMonitor';
import { convertToolsToOpenAI, getHttpsAgent } from '../providers/shared';

const logger = createLogger('AiSdkAdapter');

// resolveModel 能处理的 provider：deepseek（专用包）/ claude·anthropic（专用包）/ 普通
// openai-compatible。以下 provider 的旧 provider class 带有额外请求语义，AI SDK 路径尚未等价：
// - gemini: 原生 API，非 OpenAI-compatible。
// - xiaomi/moonshot: thinking-mode history / sampling / token 字段与旧路径不同。
// - zhipu: provider class 带并发 limiter 与三态端点行为。
// - openrouter: provider class 带必需推荐 headers 与 schema normalize。
// 这些 provider 在默认 AI SDK engine 下自动回 legacy，避免把迁移不完整的外部依赖放进热路径。
const AISDK_UNSUPPORTED_PROVIDERS = new Set<string>(['gemini', 'xiaomi', 'moonshot', 'zhipu', 'openrouter']);

/** 适配器是否能跑该 provider（false → 调用方应走旧 modelRouter 路径）。 */
export function aiSdkSupportsProvider(provider: string): boolean {
  return !AISDK_UNSUPPORTED_PROVIDERS.has(provider);
}

interface ProviderRequest {
  baseURL: string | undefined;
  apiKey: string | undefined;
  supportsTool: boolean;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined) out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function responseHeaders(headers: AxiosResponse['headers']): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, String(item));
    } else if (value !== undefined && value !== null) {
      out.set(key, String(value));
    }
  }
  return out;
}

function isNodeReadable(value: unknown): value is Readable {
  return value instanceof Readable
    || (typeof value === 'object'
      && value !== null
      && typeof (value as { pipe?: unknown }).pipe === 'function'
      && typeof (value as { on?: unknown }).on === 'function');
}

function requestBodyForAxios(body: BodyInit | null | undefined): unknown {
  if (body instanceof ReadableStream) {
    return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  }
  return body ?? undefined;
}

function toUint8Readable(readable: Readable): Readable {
  return readable.pipe(new Transform({
    transform(chunk: unknown, _encoding, callback) {
      if (typeof chunk === 'string') {
        callback(null, Buffer.from(chunk));
      } else if (chunk instanceof Uint8Array) {
        callback(null, chunk);
      } else if (chunk instanceof ArrayBuffer) {
        callback(null, Buffer.from(chunk));
      } else {
        callback(null, Buffer.from(String(chunk)));
      }
    },
  }));
}

function responseBodyForFetch(data: unknown, status: number): BodyInit | null {
  if (status === 204 || status === 304 || data == null) return null;
  if (isNodeReadable(data)) {
    return Readable.toWeb(toUint8Readable(data)) as BodyInit;
  }
  if (
    typeof data === 'string'
    || data instanceof Blob
    || data instanceof ArrayBuffer
    || ArrayBuffer.isView(data)
    || data instanceof FormData
    || data instanceof URLSearchParams
    || data instanceof ReadableStream
  ) {
    return data as BodyInit;
  }
  return JSON.stringify(data);
}

const aiSdkFetch: typeof globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : undefined;
  const url = input instanceof URL ? input.toString() : request?.url ?? String(input);
  const method = init?.method ?? request?.method ?? 'GET';
  const headers = headersToRecord(init?.headers ?? request?.headers);
  const body = requestBodyForAxios(init?.body ?? request?.body);
  const signal = init?.signal ?? request?.signal;
  const agent = getHttpsAgent(url);

  const response = await axios({
    url,
    method,
    headers,
    data: body,
    signal,
    responseType: 'stream',
    timeout: 0,
    validateStatus: () => true,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
  });

  return new Response(responseBodyForFetch(response.data, response.status), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response.headers),
  });
};

// baseURL / apiKey 走与 provider 类同一份解析（providerResolution）——不再在适配器里复制
// zhipu 三态等逻辑（消除「每加一个 provider 就要在 adapter 再打一次补丁」）。
// trustConfigKey:false：子代理 modelConfig 的 apiKey 是从父代理继承来的，provider 可能已被
// 角色策略改成别家（deepseek→zhipu/xiaomi），故按 provider 重新解析（configService→env），
// config.apiKey 仅作最后兜底，避免拿父的 key 去打子代理的 provider → "Invalid token"。
// supportsTool（能力即数据，对照 Models.dev）仍取自 providerRegistry。
function resolveProviderRequest(config: ModelConfig): ProviderRequest {
  const modelEntry = PROVIDER_REGISTRY[config.provider]?.models.find((m) => m.id === config.model);
  return {
    baseURL: resolveProviderBaseUrl(config) || undefined,
    apiKey: resolveProviderApiKey(config, { trustConfigKey: false }) || undefined,
    supportsTool: modelEntry?.supportsTool ?? true,
  };
}

// ── provider 解析：优先专用包（专用包能处理 thinking 回传等坑，通用 openai-compatible 不行）──
function resolveModel(config: ModelConfig, req: ProviderRequest): LanguageModel {
  switch (config.provider) {
    case 'deepseek':
      return createDeepSeek({ apiKey: req.apiKey, baseURL: req.baseURL, fetch: aiSdkFetch })(config.model);
    case 'anthropic':
    case 'claude':
      return createAnthropic({ apiKey: req.apiKey, baseURL: req.baseURL ?? MODEL_API_ENDPOINTS.claude, fetch: aiSdkFetch })(config.model);
    default: {
      if (!req.baseURL) {
        throw new Error(`[AiSdkAdapter] 无法解析 provider "${config.provider}" 的 baseURL`);
      }
      return createOpenAICompatible({ name: config.provider, baseURL: req.baseURL, apiKey: req.apiKey, fetch: aiSdkFetch })(config.model);
    }
  }
}

// content 运行时形状不保证（buildInferenceMessages 后可能是 string / 数组 / 对象），
// 全部容错取文本，绝不对非数组调 .filter（曾导致 "r.filter is not a function" 崩子代理）。
function textOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // 递归处理数组（MessageContent[] / OpenAI content parts）
  if (Array.isArray(content)) return content.map(textOf).join('');
  // 对象：用属性访问而非 'in' 操作符（'in' 对意外的字符串原语会抛
  // "Cannot use 'in' operator"，曾崩子代理）。兼容 {text} / {type,text} / {content}。
  if (typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (o.content != null) return textOf(o.content);
    return '';
  }
  return '';
}

// 用户消息：保留文本 + base64 图片（多模态）。content 形状容错。
function userContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textOf(content);
  const parts: unknown[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as MessageContent;
    if (c.type === 'text' && c.text) parts.push({ type: 'text', text: c.text });
    else if (c.type === 'image' && c.source?.data) {
      parts.push({ type: 'image', image: `data:${c.source.media_type};base64,${c.source.data}` });
    }
  }
  return parts.length ? parts : textOf(content);
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// tool 结果消息的 toolCallId：顶层 m.toolCallId 或结构化 m.toolResults[0].toolCallId
function toolMsgCallId(m: ModelMessage): string {
  if (m.toolCallId) return m.toolCallId;
  const tr = (m as { toolResults?: Array<{ toolCallId?: string }> }).toolResults;
  return tr?.[0]?.toolCallId ?? '';
}

// tool-call 参数运行时可能是 JSON 字符串或对象，统一成对象
function asInput(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  if (typeof args === 'string') return safeParse(args);
  return {};
}

// AI SDK 严格要求 assistant(tool-call) 后【紧跟】其 tool-result，中间不能夹 system/user，否则抛
// MissingToolResultsError（"Tool result is missing for tool call ..."）。但主 loop 会在 tool 执行期间
// （tool-result 消息入列【前】）经 injectSystemMessage 注入 system 消息（post-tool hook / 失败告警 /
// nudge / thinking step），使序列出现 assistant(tool-call) → system → tool(result)。这里把夹在
// assistant tool-call 与其 tool-result 之间的 system / 无主 tool 消息移到 tool-result 之后，恢复合法配对。
// 对齐旧 OpenAI 路径 providers/shared.ts:sanitizeToolCallOrder（同一问题旧引擎已解决，迁移到 AI SDK 时漏带）。
function reorderToolResultsAfterAssistant(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    const callIds = msg.role === 'assistant' ? (msg.toolCalls ?? []).map((tc) => tc.id) : [];
    if (callIds.length === 0) {
      out.push(msg);
      i++;
      continue;
    }
    out.push(msg);
    i++;
    const expectedIds = new Set(callIds);
    const toolResults: ModelMessage[] = [];
    const deferred: ModelMessage[] = [];
    while (i < messages.length) {
      const next = messages[i];
      const nextId = next.role === 'tool' ? toolMsgCallId(next) : '';
      if (next.role === 'tool' && nextId && expectedIds.has(nextId)) {
        toolResults.push(next);
        expectedIds.delete(nextId);
        i++;
        if (expectedIds.size === 0) break; // 该 assistant 的所有 tool-call 都配到了结果
      } else if (next.role === 'assistant' || next.role === 'user') {
        break; // 进入新一轮，不跨轮次重排
      } else {
        deferred.push(next); // system / 无主 tool 消息 → 延后到 tool-result 之后
        i++;
      }
    }
    out.push(...toolResults, ...deferred);
  }
  return out;
}

// ── Neo ModelMessage[]（结构化 inferenceMessages）→ AI SDK ModelMessage[] ──
// AI SDK 严格要求 assistant 的每个 tool-call 都配一个 tool-result，否则抛
// "Tool result is missing"。因此先建配对集合，只输出"有结果的 tool-call"和
// "有 tool-call 的结果"，把 orphan 双向丢弃（防 Neo 历史里 in-flight / 被压缩的残缺对）。
function toAiMessages(messages: ModelMessage[]): AiModelMessage[] {
  // 先重排：把夹在 assistant tool-call 与 tool-result 之间的 system/user 移到 tool-result 之后，
  // 否则 AI SDK 的配对校验会在遇到夹层 system 时报 MissingToolResultsError。
  const ordered = reorderToolResultsAfterAssistant(messages);

  const idToName = new Map<string, string>();
  const resultIds = new Set<string>();
  for (const m of ordered) {
    for (const tc of m.toolCalls ?? []) idToName.set(tc.id, tc.name);
    if (m.role === 'tool') {
      const id = toolMsgCallId(m);
      if (id) resultIds.add(id);
    }
  }

  const out: AiModelMessage[] = [];
  for (const m of ordered) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: textOf(m.content) });
    } else if (m.role === 'tool') {
      const id = toolMsgCallId(m);
      if (!id || !idToName.has(id)) continue; // orphan 结果（无对应 tool-call）→ 丢
      out.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: id,
          toolName: idToName.get(id) ?? 'tool',
          output: { type: 'text', value: textOf(m.content) },
        }],
      } as AiModelMessage);
    } else if (m.role === 'assistant') {
      const txt = textOf(m.content);
      const calls = (m.toolCalls ?? []).filter((tc) => resultIds.has(tc.id)); // 只留有结果的
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: txt || '' });
      } else {
        const parts: unknown[] = [];
        if (txt) parts.push({ type: 'text', text: txt });
        for (const tc of calls) {
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: asInput(tc.arguments) });
        }
        out.push({ role: 'assistant', content: parts } as AiModelMessage);
      }
    } else {
      out.push({ role: 'user', content: userContent(m.content) } as AiModelMessage);
    }
  }
  return out;
}

// ── 工具映射：tool() 只取 schema，不传 execute（执行仍由 Neo toolExecutor 负责）──
function buildTools(toolDefs: ToolDefinition[]): ToolSet {
  const tools: Record<string, ReturnType<typeof aiTool>> = {};
  const openAiTools = convertToolsToOpenAI(toolDefs);
  for (let i = 0; i < toolDefs.length; i++) {
    const d = toolDefs[i];
    const parameters = openAiTools[i]?.function.parameters ?? d.inputSchema;
    tools[d.name] = aiTool({
      description: d.description,
      inputSchema: jsonSchema(parameters as unknown as Parameters<typeof jsonSchema>[0]),
    });
  }
  return tools as ToolSet;
}

// 流式重试/节流常量（对齐旧路径：withTransientRetry 默认 maxRetries=2/baseDelay=1000，
// sseStream token 估算每 500ms、snapshot 默认 3000ms）。
const STREAM_MAX_RETRIES = 2;
const STREAM_RETRY_BASE_DELAY_MS = 1000;
const TOKEN_ESTIMATE_INTERVAL_MS = 500;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 3000;

// 失败诊断：定位崩在哪个阶段 + 原始消息形状（messageProcessor 下游依赖这些日志定位坑）。
function logInferenceFailure(err: unknown, stage: string, config: ModelConfig, messages: ModelMessage[]): void {
  logger.error('[AiSdkAdapter] inference failed', {
    error: err instanceof Error ? err.message : String(err),
    stage,
    provider: config.provider,
    model: config.model,
    rawMsgShapes: messages.map((m) => ({
      role: (m as { role?: string }).role,
      contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
      hasToolCalls: !!m.toolCalls?.length,
      hasToolResults: !!(m as { toolResults?: unknown[] }).toolResults?.length,
    })),
  });
}

/**
 * 与 ModelRouter.inference 同契约的 AI SDK 实现。
 * onStream 存在且未强制非流式 → 流式（streamText，逐字回调 + 累积）；
 * 否则非流式（generateText）。两条路径都【单步】（不设 stopWhen），由 Neo loop 驱动多轮。
 */
export async function inferenceViaAiSdk(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
): Promise<ModelResponse> {
  const req = resolveProviderRequest(config);
  const model = resolveModel(config, req);
  let aiTools: ToolSet | undefined;
  let aiMessages: AiModelMessage[] | undefined;
  try {
    // P1b：模型不支持 tool_call 时不传 tools（能力即数据，来自 providerRegistry）
    aiTools = tools.length > 0 && req.supportsTool ? buildTools(tools) : undefined;
    aiMessages = toAiMessages(messages);
  } catch (err) {
    const stage = !aiTools && tools.length > 0 && req.supportsTool ? 'buildTools' : 'toAiMessages';
    logInferenceFailure(err, stage, config, messages);
    throw err;
  }

  const streaming = typeof onStream === 'function' && options?.forceNonStreaming !== true;
  if (streaming) {
    return streamViaAiSdk({ model, aiMessages, aiTools, config, onStream, signal, options, messages });
  }
  return generateViaAiSdk({ model, aiMessages, aiTools, config, signal, options, messages });
}

// 给一次 provider 调用套 per-request 超时：组合「外部 signal + 内部超时」成一个 abortSignal。
// AI SDK 走 fetch 默认无请求超时，旧 axios 路径有 PROVIDER_TIMEOUT，迁移时丢了——provider 偶发
// 卡住（接受连接但响应不返回）会一直挂到外层预算耗尽（子代理 90s 硬超时），无 per-request 早退+重试。
// 用自管 setTimeout（可被 fake timers 控制，区别于 AbortSignal.timeout）；timedOut() 让调用方区分
// 「本超时（应重试）」与「外部 abort（父/预算取消，不应重试）」。
function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    timedOut: () => controller.signal.aborted,
    cleanup: () => clearTimeout(timer),
  };
}

// ── 非流式：generateText（服务子代理 + 主 loop 的 artifact 非流式重试）。行为与迁移 P0 一致 ──
async function generateViaAiSdk(params: {
  model: LanguageModel;
  aiMessages: AiModelMessage[];
  aiTools: ToolSet | undefined;
  config: ModelConfig;
  signal: AbortSignal | undefined;
  options: InferenceOptions | undefined;
  messages: ModelMessage[];
}): Promise<ModelResponse> {
  const { model, aiMessages, aiTools, config, signal, options, messages } = params;
  const requestTimeoutMs = options?.requestTimeoutMs ?? PROVIDER_TIMEOUT;
  let result;
  try {
    // maxRetries:0 关掉 SDK 自带重试，统一走项目的 withTransientRetry——后者除 HTTP 瞬态
    // (429/502/503/504) 外还覆盖纯网络错(ECONNRESET/socket hang up/ETIMEDOUT，SDK 的
    // APICallError.isRetryable 不认这些)，且带 NON_RETRYABLE_PATTERNS 护栏。避免双层重试。
    result = await withTransientRetry(
      async () => {
        // per-request 超时：超时→抛 transient（'timeout of …' 命中 retryStrategy 模式）让 withTransientRetry
        // 重试（重发一次通常就过）；外部 signal abort 则原样抛出（withTransientRetry 见 signal.aborted 不重试）。
        const guard = withRequestTimeout(signal, requestTimeoutMs);
        try {
          return await generateText({
            model,
            messages: aiMessages,
            tools: aiTools,
            abortSignal: guard.signal,
            temperature: config.temperature,
            ...(typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens)
              ? { maxOutputTokens: config.maxTokens } : {}),
            maxRetries: 0,
          });
        } catch (err) {
          if (guard.timedOut() && !signal?.aborted) {
            throw new Error(`timeout of ${requestTimeoutMs}ms exceeded`, { cause: err });
          }
          throw err;
        } finally {
          guard.cleanup();
        }
      },
      { providerName: config.provider, signal },
    );
  } catch (err) {
    logInferenceFailure(err, 'generateText', config, messages);
    throw err;
  }

  const toolCalls: ToolCall[] = (result.toolCalls ?? []).map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    // 对齐 openaiWrapper：arguments 为已解析对象
    arguments: (tc.input ?? {}) as ToolCall['arguments'],
  }));

  logger.debug('inferenceViaAiSdk done', {
    provider: config.provider, model: config.model,
    type: toolCalls.length ? 'tool_use' : 'text',
    toolCallCount: toolCalls.length,
    streaming: false,
  });

  // contentParts：text 与 tool_call 的交错顺序。老路径(openaiWrapper)对 tool_use 会带它，
  // 下游据此把 assistant.content 建成数组；缺了会建成字符串，Neo 转换器下一轮
  // 对其 .content.filter 崩（"r.content.filter is not a function"）。对齐契约。
  const contentParts: NonNullable<ModelResponse['contentParts']> = [];
  if (result.text) contentParts.push({ type: 'text', text: result.text });
  for (const tc of toolCalls) contentParts.push({ type: 'tool_call', toolCallId: tc.id });

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content: result.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    contentParts: contentParts.length > 0 ? contentParts : undefined,
    thinking: result.reasoningText || undefined,
    usage: {
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
    },
    finishReason: result.finishReason,
  };
}

// ── 流式累积状态（每次重试尝试用全新实例）──
interface StreamAccumulator {
  content: string;
  reasoning: string;
  finishReason: string | undefined;
  usage: { inputTokens: number; outputTokens: number } | undefined;
  // 按 toolCallId 索引；index 保留模型发出的先后顺序，对齐 SSE delta.tool_calls[].index 语义。
  toolCalls: Map<string, { id: string; name: string; argsText: string; input?: Record<string, unknown>; index: number }>;
  contentParts: ResponseContentPart[];
  lastPartType: 'text' | 'tool_call' | null;
  charCount: number;
  nextToolIndex: number;
}

function createAccumulator(): StreamAccumulator {
  return {
    content: '', reasoning: '', finishReason: undefined, usage: undefined,
    toolCalls: new Map(), contentParts: [], lastPartType: null, charCount: 0, nextToolIndex: 0,
  };
}

function registerToolCall(acc: StreamAccumulator, id: string, name: string) {
  let entry = acc.toolCalls.get(id);
  if (!entry) {
    entry = { id, name, argsText: '', index: acc.nextToolIndex++ };
    acc.toolCalls.set(id, entry);
    // 追踪交错：记录 tool_call 在内容流中的出现位置（对齐 sseStream contentParts）。
    acc.contentParts.push({ type: 'tool_call', toolCallId: id });
    acc.lastPartType = 'tool_call';
  }
  return entry;
}

function stringifyArgs(input: Record<string, unknown> | undefined, fallback: string): string {
  if (!input) return fallback;
  try { return JSON.stringify(input); } catch { return fallback; }
}

function buildStreamResponse(acc: StreamAccumulator, config: ModelConfig): ModelResponse {
  const toolCalls: ToolCall[] = [...acc.toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((t) => ({
      id: t.id,
      name: t.name,
      // 权威 input（已解析对象）优先；provider 未在 tool-call 给 input 时回落解析累积的 argsText。
      arguments: (t.input ?? safeParse(t.argsText)) as ToolCall['arguments'],
    }));

  logger.debug('inferenceViaAiSdk done', {
    provider: config.provider, model: config.model,
    type: toolCalls.length ? 'tool_use' : 'text',
    toolCallCount: toolCalls.length,
    streaming: true,
  });

  return {
    type: toolCalls.length > 0 ? 'tool_use' : 'text',
    content: acc.content || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    contentParts: acc.contentParts.length > 0 ? acc.contentParts : undefined,
    thinking: acc.reasoning || undefined,
    usage: acc.usage || { inputTokens: 0, outputTokens: Math.ceil(acc.charCount / 4) },
    finishReason: acc.finishReason,
    truncated: acc.finishReason === 'length',
  };
}

// ── 流式：streamText 消费 fullStream，事件→StreamChunk（对齐 sseStream openAISSEStream），
//    最终累积出与非流式同形状的 ModelResponse。服务主 agent loop 的逐字输出 ──
async function streamViaAiSdk(params: {
  model: LanguageModel;
  aiMessages: AiModelMessage[];
  aiTools: ToolSet | undefined;
  config: ModelConfig;
  onStream: StreamCallback;
  signal: AbortSignal | undefined;
  options: InferenceOptions | undefined;
  messages: ModelMessage[];
}): Promise<ModelResponse> {
  const { model, aiMessages, aiTools, config, onStream, signal, options, messages } = params;
  const healthMonitor = getProviderHealthMonitor();
  const maxRetries = options?.disableProviderTransientRetry ? 0 : STREAM_MAX_RETRIES;
  const snapshotInterval = options?.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const onSnapshot = options?.onSnapshot;

  for (let attempt = 0; ; attempt++) {
    const startTime = Date.now();
    // 每次尝试用全新累积器：emittedOutput 闸门保证只在「尚未吐过任何 delta」时才会到这里，
    // 故重置 content/toolCalls 不会丢用户已看到的内容。
    const acc = createAccumulator();
    let emittedOutput = false;
    let lastEstimateAt = 0;
    let lastSnapshotAt = 0;

    const emitSnapshot = (isFinal: boolean): void => {
      if (!onSnapshot) return;
      const snapshot: StreamSnapshot = {
        content: acc.content,
        reasoning: acc.reasoning,
        toolCalls: [...acc.toolCalls.values()].map((t) => ({
          id: t.id, name: t.name, arguments: stringifyArgs(t.input, t.argsText),
        })),
        estimatedTokens: Math.ceil(acc.charCount / 4),
        timestamp: Date.now(),
        isFinal,
      };
      onSnapshot(snapshot);
    };

    // 首字节 / inactivity 看门狗：AI SDK 流式默认无超时，旧 sseStream 路径有
    // SSE_FIRST_BYTE_TIMEOUT/SSE_INACTIVITY_TIMEOUT，迁移时丢了——provider 流卡住会一直挂。
    // 自管 timer（fake-timer 可控）超时即 abort watchdog，与外部 signal 组合喂 streamText；
    // 命中后 catch 据 timedOutKind 改成 retryStrategy 认得的瞬态文案（首字节前才重试，emittedOutput 兜底）。
    const firstByteMs = options?.firstByteTimeoutMs ?? SSE_FIRST_BYTE_TIMEOUT;
    const inactivityMs = options?.inactivityTimeoutMs ?? SSE_INACTIVITY_TIMEOUT;
    const watchdog = new AbortController();
    let timedOutKind: 'first-byte' | 'stream inactivity' | null = null;
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = (ms: number, kind: 'first-byte' | 'stream inactivity'): void => {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = setTimeout(() => { timedOutKind = kind; watchdog.abort(); }, ms);
    };
    const stopWatchdog = (): void => {
      if (activityTimer) { clearTimeout(activityTimer); activityTimer = undefined; }
    };
    armWatchdog(firstByteMs, 'first-byte');
    const streamSignal = signal ? AbortSignal.any([signal, watchdog.signal]) : watchdog.signal;

    try {
      const result = streamText({
        model,
        messages: aiMessages,
        tools: aiTools,
        abortSignal: streamSignal,
        temperature: config.temperature,
        // 主 loop 的 artifact 生成/修复按阶段 cap maxTokens，必须透传给 SDK 保住上限；
        // 未设时交给 provider 默认（与旧 SSE 路径 buildRequestBody 的 max_tokens 行为对齐）。
        ...(typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens)
          ? { maxOutputTokens: config.maxTokens } : {}),
        maxRetries: 0,
      });

      for await (const part of result.fullStream as AsyncIterable<TextStreamPart<ToolSet>>) {
        // 收到任意事件即重置为 inactivity 窗口（首个事件顺带解除 first-byte 窗口）。
        armWatchdog(inactivityMs, 'stream inactivity');
        switch (part.type) {
          case 'text-delta': {
            const delta = part.text;
            if (!delta) break;
            if (acc.lastPartType !== 'text') {
              acc.contentParts.push({ type: 'text', text: '' });
              acc.lastPartType = 'text';
            }
            const lastPart = acc.contentParts[acc.contentParts.length - 1];
            if (lastPart?.type === 'text') lastPart.text += delta;
            acc.content += delta;
            acc.charCount += delta.length;
            emittedOutput = true;
            onStream({ type: 'text', content: delta });
            const now = Date.now();
            if (now - lastEstimateAt > TOKEN_ESTIMATE_INTERVAL_MS) {
              lastEstimateAt = now;
              onStream({ type: 'token_estimate', inputTokens: 0, outputTokens: Math.ceil(acc.charCount / 4) });
            }
            break;
          }
          case 'reasoning-delta': {
            const delta = part.text;
            if (!delta) break;
            acc.reasoning += delta;
            emittedOutput = true;
            onStream({ type: 'reasoning', content: delta });
            break;
          }
          case 'tool-input-start': {
            const entry = registerToolCall(acc, part.id, part.toolName);
            emittedOutput = true;
            onStream({ type: 'tool_call_start', toolCall: { index: entry.index, id: part.id, name: part.toolName } });
            break;
          }
          case 'tool-input-delta': {
            const entry = acc.toolCalls.get(part.id);
            if (!entry) break;
            entry.argsText += part.delta;
            onStream({ type: 'tool_call_delta', toolCall: { index: entry.index, argumentsDelta: part.delta } });
            break;
          }
          case 'tool-call': {
            // 权威终值：input 是已解析对象。provider 不流式工具参数时不会有 input-start，
            // 这里补注册 + 补发 tool_call_start，保证下游拿得到 id/name/index。
            let entry = acc.toolCalls.get(part.toolCallId);
            if (!entry) {
              entry = registerToolCall(acc, part.toolCallId, part.toolName);
              emittedOutput = true;
              onStream({ type: 'tool_call_start', toolCall: { index: entry.index, id: part.toolCallId, name: part.toolName } });
            }
            entry.name = part.toolName || entry.name;
            entry.input = (part.input ?? {}) as Record<string, unknown>;
            break;
          }
          case 'finish': {
            acc.finishReason = part.finishReason;
            acc.usage = {
              inputTokens: part.totalUsage?.inputTokens ?? 0,
              outputTokens: part.totalUsage?.outputTokens ?? 0,
            };
            break;
          }
          case 'error': {
            // streamText 默认把错误作为流事件而非抛出；抛出交给下面 catch 统一处理（重试/上报）。
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          case 'abort': {
            throw new Error('Request was cancelled');
          }
          default:
            break;
        }
        if (onSnapshot && Date.now() - lastSnapshotAt > snapshotInterval) {
          lastSnapshotAt = Date.now();
          emitSnapshot(false);
        }
      }

      stopWatchdog();
      // 正常完成：发 usage + complete（对齐 sseStream），落最终 snapshot，累积成 ModelResponse。
      healthMonitor.recordSuccess(config.provider, Date.now() - startTime);
      if (acc.usage) {
        onStream({ type: 'usage', inputTokens: acc.usage.inputTokens, outputTokens: acc.usage.outputTokens });
      }
      onStream({ type: 'complete', finishReason: acc.finishReason || 'stop' });
      emitSnapshot(true);
      return buildStreamResponse(acc, config);
    } catch (err) {
      stopWatchdog();
      const code = (err as NodeJS.ErrnoException).code;
      // 看门狗超时（且非外部 abort）→ 改成 retryStrategy 认得的瞬态文案；外部 signal abort 保持原始错误。
      const watchdogTimedOut = timedOutKind !== null && !signal?.aborted;
      const msg = watchdogTimedOut
        ? `${timedOutKind} timeout`
        : (err instanceof Error ? err.message : String(err));
      // emittedOutput 闸门：已向用户吐过 delta → 绝不重试（避免重复 emit）；只在首个可见
      // delta 之前的瞬态失败才重试，复用项目 isTransientError 策略（与旧路径同一套护栏）。
      if (!emittedOutput && attempt < maxRetries && !signal?.aborted && isTransientError(msg, code)) {
        logger.warn(`[AiSdkAdapter] 流式瞬态错误 "${msg}" (code=${code})，首字节前重试 (${attempt + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, STREAM_RETRY_BASE_DELAY_MS * (attempt + 1)));
        continue;
      }
      healthMonitor.recordFailure(config.provider);
      if (!signal?.aborted) {
        onStream({ type: 'error', error: msg, ...(code ? { errorCode: code } : {}) });
      }
      const finalErr = watchdogTimedOut ? new Error(msg, { cause: err }) : err;
      logInferenceFailure(finalErr, 'streamText', config, messages);
      throw finalErr;
    }
  }
}
