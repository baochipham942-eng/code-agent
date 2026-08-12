// ============================================================================
// ResponsesProvider — 独立的 /responses 适配器；不继承 BaseOpenAIProvider，
// 因为请求/响应均不是 /chat/completions SSE 形态。
// ============================================================================
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { InferenceOptions, ModelMessage, ModelResponse, Provider, StreamCallback } from '../types';
import { resolveModelCapabilities } from '../modelCapabilityMatrix';
import { electronFetch, logger } from './shared';
import { resolveProviderApiKey, resolveProviderBaseUrl } from './providerResolution';
import { parseResponsesResponse } from './wrappers/responsesWrapper';

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
    return [{ role: message.role, content }];
  });
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
    if (tools.length > 0) {
      // v1 只接内置 web_search，不转 function tools（Responses 的工具形态是扁平的
      // {type:'function',name,parameters} + function_call/function_call_output 往返，与
      // chat-completions 那套不通用）。静默丢掉会让 agent 循环无声失去全部工具能力，
      // 所以这里必须喊出来——切到本协议前先确认调用方不依赖工具。
      logger.warn('[Responses] v1 不转发 function tools，本轮工具全部被丢弃', {
        provider: config.provider, model: config.model, droppedTools: tools.length,
      });
    }
    const baseUrl = resolveProviderBaseUrl(config);
    const endpoint = resolveResponsesEndpoint(baseUrl);
    const body: Record<string, unknown> = {
      model: config.model,
      input: buildResponsesInput(messages),
      store: false,
    };
    if (resolveModelCapabilities(config.provider, config.model).search?.mode === 'deepseek-responses') {
      body.tools = [{ type: 'web_search' }];
    }

    // ponytail: v1 非流式——服务端 agent 循环一次性返回；要增量体验再上 stream:true 事件解析
    const response = await electronFetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolveProviderApiKey(config)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      provider: config.provider,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw Object.assign(new Error(`Responses API (${response.status}): ${errorText.slice(0, 500)}`), {
        status: response.status, provider: config.provider, model: config.model,
      });
    }
    const result = parseResponsesResponse(await response.json());
    if (onStream && result.thinking) onStream({ type: 'reasoning', content: result.thinking });
    if (onStream && result.content) onStream({ type: 'text', content: result.content });
    if (onStream && result.usage) onStream({ type: 'usage', ...result.usage });
    logger.debug('[Responses] complete response parsed', { searchCalls: result.searchTrace?.length ?? 0 });
    return result;
  }
}
