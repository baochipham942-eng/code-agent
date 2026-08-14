// ============================================================================
// ResponsesProvider — 独立的 /responses 适配器；不继承 BaseOpenAIProvider，
// 因为请求/响应均不是 /chat/completions SSE 形态。
// ============================================================================
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { InferenceOptions, ModelMessage, ModelResponse, Provider, StreamCallback } from '../types';
import { resolveModelCapabilities } from '../modelCapabilityMatrix';
import { electronFetch, logger } from './shared';
import { resolveProviderApiKey, resolveProviderBaseUrl } from './providerResolution';
import { convertToolsToResponses, parseResponsesResponse } from './wrappers/responsesWrapper';

/**
 * 末尾斜杠照剥；/v\d+ 只在 atApiRoot 为 true 时剥。
 * 官方 DeepSeek 的 Responses 在 API 根（api.deepseek.com/responses，而 baseUrl 常量是 .../v1）；
 * 中转站的 Responses 就在 baseUrl 之下的 /responses（如 /v1/responses），剥掉 /v1 会打到根路径 405。
 */
function resolveResponsesEndpoint(baseUrl: string, atApiRoot: boolean): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${atApiRoot ? trimmed.replace(/\/v\d+$/, '') : trimmed}/responses`;
}

function buildResponsesInput(messages: ModelMessage[]): unknown[] {
  return messages.flatMap((message) => {
    // 无状态续聊的唯一可靠写法：把服务端整个 output（含 web_search_call）原样送回。
    if (message.role === 'assistant' && message.responsesOutput?.length) return message.responsesOutput;
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => part.type === 'text' ? part.text ?? '' : '').join('');
    if (message.role === 'tool' && message.toolCallId) {
      return [{ type: 'function_call_output', call_id: message.toolCallId, output: content }];
    }
    return [{ role: message.role, content }];
  });
}

async function* chunksOf(body: ReadableStream<Uint8Array> | NodeJS.ReadableStream): AsyncGenerator<string> {
  if ('getReader' in body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
      const rest = decoder.decode();
      if (rest) yield rest;
    } finally { reader.releaseLock(); }
    return;
  }
  for await (const chunk of body) yield Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
}

function searchProgress(item: Record<string, unknown>): string {
  const action = item.action as Record<string, unknown> | undefined;
  const query = action?.query ?? item.query;
  const url = action?.url ?? item.url;
  return query ? `正在搜索：${query}` : url ? `正在打开：${url}` : '正在搜索资料';
}

async function parseResponsesStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  onStream: StreamCallback,
): Promise<ModelResponse> {
  let buffer = '';
  const functionCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let completed: unknown | undefined;

  // 流式下无法在 message 开始时就知道它是不是最后一条（后面还会不会再来 call）。
  // 所以把当前 message 的正文攒起来：一旦下一个 output item 开始，就说明刚才那条是过程旁白
  // ⇒ 改道进度轨；攒到 response.completed 还没被顶掉的那条，才是答案。
  // 真机实测（2026-08-12）：不这么做，「搜索到了一些信息，让我打开官方页面确认…」会被当正文
  // 推给用户，随后又被最终 content 换掉（流式 2459 字 vs 最终 2062 字）。
  let pendingText = '';
  const demotedPendingToProgress = () => {
    if (!pendingText) return;
    onStream({ type: 'reasoning', content: pendingText });
    pendingText = '';
  };
  // function_call 是同一模型轮从「交代接下来要做什么」切到工具参数流的边界。
  // 在这里把已产出的正文先交给下游：否则它会一直留在 pendingText，直到工具轮结束，
  // 消费这条正文流的界面会出现一段无反馈的死气。web_search 的过程旁白仍走 reasoning，不混淆。
  // flushedText 记录已下发的正文总和，收尾只补差量，保证「推给用户的正文===最终 content」不双发。
  let flushedText = '';
  const flushPendingToText = () => {
    if (!pendingText) return;
    flushedText += pendingText;
    onStream({ type: 'text', content: pendingText });
    pendingText = '';
  };

  const handle = (event: Record<string, unknown>) => {
    const type = String(event.type ?? '');
    const index = typeof event.output_index === 'number' ? event.output_index : 0;
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
    if (type === 'response.output_item.added' && item) {
      if (item.type === 'function_call') {
        flushPendingToText();
        const call = { id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : undefined, name: typeof item.name === 'string' ? item.name : undefined, arguments: '' };
        functionCalls.set(index, call);
        onStream({ type: 'tool_call_start', toolCall: { index, id: call.id, name: call.name } });
      } else {
        demotedPendingToProgress();
      }
      return;
    }
    if (type.startsWith('response.web_search_call')) {
      const trace = item ?? event;
      demotedPendingToProgress();
      onStream({ type: 'reasoning', content: searchProgress(trace) });
      return;
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      pendingText += event.delta;
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      onStream({ type: 'reasoning', content: event.delta });
      return;
    }
    if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
      // 某些兼容端只给 arguments.delta、不先给 output_item.added；同样不能让 preamble
      // 被工具参数缓冲跨过。重复调用是安全的，因为第一次已清空 pendingText。
      flushPendingToText();
      const call = functionCalls.get(index) ?? { arguments: '' };
      call.arguments += event.delta;
      functionCalls.set(index, call);
      onStream({ type: 'tool_call_delta', toolCall: { index, argumentsDelta: event.delta } });
      return;
    }
    if (type === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
      const call = functionCalls.get(index) ?? { arguments: '' };
      call.arguments = event.arguments;
      functionCalls.set(index, call);
      return;
    }
    if (type === 'response.completed') completed = event.response;
  };

  for await (const chunk of chunksOf(body)) {
    buffer += chunk;
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      try { handle(JSON.parse(data) as Record<string, unknown>); } catch { logger.debug('[Responses] skipping malformed SSE event'); }
    }
  }
  if (!completed || typeof completed !== 'object') throw new Error('Responses stream completed without response payload');
  const result = parseResponsesResponse(completed);
  // 收尾以 result.content 为准（它按完整 output 算最后一个 *_call 的边界，是唯一权威口径），
  // 保证「推给用户的正文」与「最终 content」逐字一致。pendingText 只用来判断答案是否已攒到。
  // ponytail: 答案在 completed 时整段落地，不逐字流——协议在 message 结束前无法判定它是不是
  // 最后一条，要逐字流就得让流协议支持撤回临时正文。搜索/思考进度全程是实时的。
  pendingText = '';
  if (result.content) {
    if (!flushedText) {
      onStream({ type: 'text', content: result.content });
    } else if (result.content.startsWith(flushedText)) {
      const remainder = result.content.slice(flushedText.length);
      if (remainder) onStream({ type: 'text', content: remainder });
    } else {
      // 已下发正文与最终 content 不一致（不应发生）：宁可少发也不双发/闪变，留日志追查。
      logger.warn('[Responses] 流式已下发正文与最终 content 不一致，跳过收尾补发', {
        flushedLength: flushedText.length,
        contentLength: result.content.length,
      });
    }
  }
  if (result.usage) onStream({ type: 'usage', ...result.usage });
  return result;
}

export class ResponsesProvider implements Provider {
  readonly name = 'Responses';

  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    const baseUrl = resolveProviderBaseUrl(config);
    const caps = resolveModelCapabilities(config.provider, config.model);
    const endpoint = resolveResponsesEndpoint(baseUrl, caps.responsesAtApiRoot === true);
    const body: Record<string, unknown> = {
      model: config.model,
      input: buildResponsesInput(messages),
      store: false,
    };
    const responseTools: unknown[] = [];
    // 逐轮「联网搜索」开关（默认开）：关掉时这一轮不挂 web_search，矩阵裁决让位。
    if (options?.searchEnabled !== false && caps.search?.mode === 'deepseek-responses') responseTools.push({ type: 'web_search' });
    responseTools.push(...convertToolsToResponses(tools));
    if (responseTools.length) body.tools = responseTools;
    if (onStream) body.stream = true;

    if (process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD) {
      const { dumpModelPayload } = await import('../modelPayloadDump');
      await dumpModelPayload({
        body,
        provider: config.provider,
        protocol: 'responses',
        url: endpoint,
      });
    }

    const response = await electronFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolveProviderApiKey(config)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      provider: config.provider,
      ...(onStream ? { stream: true } : {}),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw Object.assign(new Error(`Responses API (${response.status}): ${errorText.slice(0, 500)}`), {
        status: response.status, provider: config.provider, model: config.model,
      });
    }
    if (onStream && response.body) return parseResponsesStream(response.body, onStream);
    const result = parseResponsesResponse(await response.json());
    if (onStream && result.thinking) onStream({ type: 'reasoning', content: result.thinking });
    if (onStream && result.content) onStream({ type: 'text', content: result.content });
    if (onStream && result.usage) onStream({ type: 'usage', ...result.usage });
    logger.debug('[Responses] complete response parsed', { searchCalls: result.searchTrace?.length ?? 0 });
    return result;
  }
}
