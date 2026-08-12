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

/** /v1 是 chat-completions API version；Responses 位于 API 根的 /responses。 */
function resolveResponsesEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '')}/responses`;
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
  let lastCallIndex = -1;
  let emittedText = false;
  const functionCalls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let completed: unknown | undefined;

  const handle = (event: Record<string, unknown>) => {
    const type = String(event.type ?? '');
    const index = typeof event.output_index === 'number' ? event.output_index : 0;
    const item = event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined;
    if (type === 'response.output_item.added' && item) {
      if (String(item.type).endsWith('_call')) lastCallIndex = Math.max(lastCallIndex, index);
      if (item.type === 'function_call') {
        const call = { id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : undefined, name: typeof item.name === 'string' ? item.name : undefined, arguments: '' };
        functionCalls.set(index, call);
        onStream({ type: 'tool_call_start', toolCall: { index, id: call.id, name: call.name } });
      }
      return;
    }
    if (type.startsWith('response.web_search_call')) {
      const trace = item ?? event;
      lastCallIndex = Math.max(lastCallIndex, index);
      onStream({ type: 'reasoning', content: searchProgress(trace) });
      return;
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      // 在最后一个 *_call 前出现的 message 是 agent 过程旁白，不进入正文轨。
      if (lastCallIndex >= 0 && index > lastCallIndex) {
        emittedText = true;
        onStream({ type: 'text', content: event.delta });
      }
      return;
    }
    if (type === 'response.reasoning_summary_text.delta' && typeof event.delta === 'string') {
      onStream({ type: 'reasoning', content: event.delta });
      return;
    }
    if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
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
  // call 可能晚于过程 message 才到 SSE；在确认本轮无 call 前先缓冲正文，避免把旁白吐给用户。
  if (!emittedText && result.content) onStream({ type: 'text', content: result.content });
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
    _options?: InferenceOptions,
  ): Promise<ModelResponse> {
    const baseUrl = resolveProviderBaseUrl(config);
    const endpoint = resolveResponsesEndpoint(baseUrl);
    const body: Record<string, unknown> = {
      model: config.model,
      input: buildResponsesInput(messages),
      store: false,
    };
    const responseTools: unknown[] = [];
    if (resolveModelCapabilities(config.provider, config.model).search?.mode === 'deepseek-responses') responseTools.push({ type: 'web_search' });
    responseTools.push(...convertToolsToResponses(tools));
    if (responseTools.length) body.tools = responseTools;
    if (onStream) body.stream = true;

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
