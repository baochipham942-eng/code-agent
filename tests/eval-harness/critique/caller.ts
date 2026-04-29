import type { CritiqueCaller } from '../../../src/design/critique';

export interface OpenAICompatibleCallerConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

export class CallerError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = 'CallerError';
  }
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 1024;

export function createOpenAICompatibleCaller(config: OpenAICompatibleCallerConfig): CritiqueCaller {
  if (!config.apiKey) throw new Error('caller: apiKey is required');
  if (!config.endpoint) throw new Error('caller: endpoint is required');
  if (!config.model) throw new Error('caller: model is required');

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.endpoint.replace(/\/+$/, '')}/chat/completions`;

  return async (prompt: string) => {
    const messages: ChatCompletionMessage[] = [{ role: 'user', content: prompt }];
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      }),
      signal: config.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CallerError(
        `caller: HTTP ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new CallerError('caller: empty content in response', response.status);
    }
    return content;
  };
}
