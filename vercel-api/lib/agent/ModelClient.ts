// ============================================================================
// ModelClient - 统一的模型调用接口
// 支持 DeepSeek、OpenAI、Anthropic 等多个 Provider
// ============================================================================

export type ModelProvider = 'deepseek' | 'openai' | 'anthropic';

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ModelResponse {
  content: string;
  toolCalls?: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface StreamEvent {
  type: 'text' | 'tool_use' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
}

// Provider API 端点
const PROVIDER_ENDPOINTS: Record<ModelProvider, string> = {
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

// 默认模型
const DEFAULT_MODELS: Record<ModelProvider, string> = {
  deepseek: 'deepseek-chat',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
};

/**
 * 统一的模型客户端
 */
export class ModelClient {
  private config: ModelConfig;

  constructor(config: ModelConfig) {
    this.config = {
      maxTokens: 4096,
      temperature: 0.7,
      ...config,
    };
  }

  /**
   * 非流式调用
   */
  async chat(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ModelResponse> {
    const { provider } = this.config;

    if (provider === 'anthropic') {
      return this.chatAnthropic(messages, options);
    } else {
      // DeepSeek 和 OpenAI 使用相同的 API 格式
      return this.chatOpenAICompatible(messages, options);
    }
  }

  /**
   * 流式调用
   */
  async *stream(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): AsyncGenerator<StreamEvent> {
    const { provider } = this.config;

    if (provider === 'anthropic') {
      yield* this.streamAnthropic(messages, options);
    } else {
      yield* this.streamOpenAICompatible(messages, options);
    }
  }

  // ============================================================================
  // OpenAI Compatible API (DeepSeek, OpenAI)
  // ============================================================================

  private async chatOpenAICompatible(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ModelResponse> {
    const { provider, model, apiKey, maxTokens, temperature } = this.config;
    const endpoint = PROVIDER_ENDPOINTS[provider];

    // 构建消息数组
    const apiMessages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      apiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    apiMessages.push(...messages);

    // 构建请求体
    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      max_tokens: options?.maxTokens || maxTokens,
      temperature: options?.temperature ?? temperature,
    };

    // 添加工具（如果有）
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${provider} API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0];
    const toolCalls = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    return {
      content: choice.message.content || '',
      toolCalls,
      stopReason:
        choice.finish_reason === 'tool_calls'
          ? 'tool_use'
          : choice.finish_reason === 'length'
            ? 'max_tokens'
            : 'end_turn',
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens,
            outputTokens: data.usage.completion_tokens,
          }
        : undefined,
    };
  }

  private async *streamOpenAICompatible(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): AsyncGenerator<StreamEvent> {
    const { provider, model, apiKey, maxTokens, temperature } = this.config;
    const endpoint = PROVIDER_ENDPOINTS[provider];

    const apiMessages: Array<{ role: string; content: string }> = [];
    if (options?.systemPrompt) {
      apiMessages.push({ role: 'system', content: options.systemPrompt });
    }
    apiMessages.push(...messages);

    const body: Record<string, unknown> = {
      model,
      messages: apiMessages,
      max_tokens: options?.maxTokens || maxTokens,
      temperature: options?.temperature ?? temperature,
      stream: true,
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        yield { type: 'error', error: `${provider} API error: ${response.status} - ${errorText}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: 'error', error: 'No response body' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentToolCall: Partial<ToolCall> | null = null;
      let toolCallArgs = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            if (currentToolCall?.id && currentToolCall?.name) {
              yield {
                type: 'tool_use',
                toolCall: {
                  id: currentToolCall.id,
                  name: currentToolCall.name,
                  input: JSON.parse(toolCallArgs || '{}'),
                },
              };
            }
            yield { type: 'done' };
            return;
          }

          try {
            const chunk = JSON.parse(data) as {
              choices: Array<{
                delta: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };

            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              yield { type: 'text', content: delta.content };
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  currentToolCall = { id: tc.id, name: tc.function?.name };
                  toolCallArgs = tc.function?.arguments || '';
                } else if (tc.function?.arguments) {
                  toolCallArgs += tc.function.arguments;
                }
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // ============================================================================
  // Anthropic API
  // ============================================================================

  private async chatAnthropic(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): Promise<ModelResponse> {
    const { model, apiKey, maxTokens, temperature } = this.config;

    // 转换消息格式
    const apiMessages = messages.map((m) => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.maxTokens || maxTokens,
      messages: apiMessages,
    };

    if (options?.systemPrompt) {
      body.system = options.systemPrompt;
    }

    if (options?.temperature !== undefined || temperature !== undefined) {
      body.temperature = options?.temperature ?? temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    const response = await fetch(PROVIDER_ENDPOINTS.anthropic, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    const textContent = data.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolCalls = data.content
      .filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use'
      )
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason:
        data.stop_reason === 'tool_use'
          ? 'tool_use'
          : data.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'end_turn',
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    };
  }

  private async *streamAnthropic(
    messages: ChatMessage[],
    options?: {
      systemPrompt?: string;
      tools?: ToolDefinition[];
      maxTokens?: number;
      temperature?: number;
    }
  ): AsyncGenerator<StreamEvent> {
    const { model, apiKey, maxTokens, temperature } = this.config;

    const apiMessages = messages.map((m) => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }));

    const body: Record<string, unknown> = {
      model,
      max_tokens: options?.maxTokens || maxTokens,
      messages: apiMessages,
      stream: true,
    };

    if (options?.systemPrompt) {
      body.system = options.systemPrompt;
    }

    if (options?.temperature !== undefined || temperature !== undefined) {
      body.temperature = options?.temperature ?? temperature;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }

    try {
      const response = await fetch(PROVIDER_ENDPOINTS.anthropic, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        yield { type: 'error', error: `Anthropic API error: ${response.status} - ${errorText}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: 'error', error: 'No response body' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentToolCall: Partial<ToolCall> | null = null;
      let toolCallInput = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              content_block?: { type: string; id?: string; name?: string };
              delta?: { type: string; text?: string; partial_json?: string };
            };

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                currentToolCall = {
                  id: event.content_block.id,
                  name: event.content_block.name,
                };
                toolCallInput = '';
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta' && event.delta.text) {
                yield { type: 'text', content: event.delta.text };
              } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
                toolCallInput += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              if (currentToolCall?.id && currentToolCall?.name) {
                yield {
                  type: 'tool_use',
                  toolCall: {
                    id: currentToolCall.id,
                    name: currentToolCall.name,
                    input: JSON.parse(toolCallInput || '{}'),
                  },
                };
                currentToolCall = null;
              }
            } else if (event.type === 'message_stop') {
              yield { type: 'done' };
              return;
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}

/**
 * 创建模型客户端的工厂函数
 */
export function createModelClient(
  provider: ModelProvider,
  apiKey: string,
  model?: string
): ModelClient {
  return new ModelClient({
    provider,
    apiKey,
    model: model || DEFAULT_MODELS[provider],
  });
}
