import type { CritiqueCaller } from '../../../src/design/critique';

export interface OpenAICompatibleCallerConfig {
  apiKey: string;
  endpoint: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 5xx 或 fetch 网络错时重试次数，默认 2（即最多 3 次尝试）。设 0 关闭。 */
  retries?: number;
  /** 重试间隔基数 ms，指数退避 base * 2^attempt。默认 500ms。 */
  retryBaseMs?: number;
}

interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ReasoningDetail {
  type?: string;
  text?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_details?: ReasoningDetail[];
    };
  }>;
}

export class CallerError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = 'CallerError';
  }
}

const DEFAULT_TEMPERATURE = 0.2;
// reasoning model (Kimi K2.5) 把思考写进 reasoning 字段，content + reasoning 合计可能上千 token，
// 1024 容易把 reasoning 用完后 content 还没出。3072 给两边留足余量。
const DEFAULT_MAX_TOKENS = 3072;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function extractContent(message: NonNullable<NonNullable<ChatCompletionResponse['choices']>[0]['message']>): string | undefined {
  if (typeof message.content === 'string' && message.content.length > 0) {
    return message.content;
  }
  // Reasoning model fallback: 拿最后一段 reasoning_details.text 或 reasoning 字段。
  // critique prompt 要求 JSON 输出，reasoning 里通常含 model 思考完后给出的 JSON。
  if (typeof message.reasoning === 'string' && message.reasoning.length > 0) {
    return message.reasoning;
  }
  if (Array.isArray(message.reasoning_details)) {
    for (let i = message.reasoning_details.length - 1; i >= 0; i -= 1) {
      const detail = message.reasoning_details[i];
      if (typeof detail?.text === 'string' && detail.text.length > 0) {
        return detail.text;
      }
    }
  }
  return undefined;
}

export function createOpenAICompatibleCaller(config: OpenAICompatibleCallerConfig): CritiqueCaller {
  if (!config.apiKey) throw new Error('caller: apiKey is required');
  if (!config.endpoint) throw new Error('caller: endpoint is required');
  if (!config.model) throw new Error('caller: model is required');

  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `${config.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const retries = config.retries ?? DEFAULT_RETRIES;
  const retryBaseMs = config.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

  async function attempt(prompt: string): Promise<string> {
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
    const message = data.choices?.[0]?.message;
    if (!message) {
      throw new CallerError('caller: response has no choices[0].message', response.status);
    }
    const content = extractContent(message);
    if (!content) {
      throw new CallerError('caller: empty content/reasoning in response', response.status);
    }
    return content;
  }

  function isRetryable(err: unknown): boolean {
    if (err instanceof CallerError && typeof err.status === 'number' && err.status >= 500) {
      return true;
    }
    // fetch network error (DNS / socket / TLS)：node fetch 抛 TypeError('fetch failed')
    if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) {
      return true;
    }
    return false;
  }

  return async (prompt: string) => {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return await attempt(prompt);
      } catch (err) {
        lastErr = err;
        if (i === retries || !isRetryable(err)) throw err;
        await sleep(retryBaseMs * Math.pow(2, i));
      }
    }
    throw lastErr;
  };
}
