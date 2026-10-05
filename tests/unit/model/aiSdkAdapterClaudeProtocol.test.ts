// custom provider protocol=claude 必须走 Anthropic Messages，而不是 /chat/completions。
// fetch 只走 makeAiSdkFetch 的桩，回放 tests/fixtures/glm-anthropic-sse-sample.txt。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { normalizeAnthropicBaseUrl } from '../../../src/host/model/adapters/aiSdkProtocol';
import type { InferenceOptions, StreamCallback, StreamChunk } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract';

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/glm-anthropic-sse-sample.txt',
);
const ANTHROPIC_SSE = readFileSync(FIXTURE_PATH, 'utf8');
const OPENAI_SSE = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const VENDOR_NOT_FOUND = '{"code":500,"msg":"404 NOT_FOUND","success":false}';
const MESSAGES_URL = 'https://open.bigmodel.cn/api/anthropic/v1/messages';

type ResponseMode = 'fixture' | 'json-200' | 'http-404';

const harness = vi.hoisted(() => {
  Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });
  const calls: { url: string; body: string }[] = [];
  let responseMode: ResponseMode = 'fixture';
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? rawBody : '';
    calls.push({ url, body });
    if (responseMode === 'json-200') {
      return new Response(VENDOR_NOT_FOUND, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (responseMode === 'http-404') {
      return new Response('not found', { status: 404, statusText: 'Not Found' });
    }
    const payload = url.includes('/chat/completions') ? OPENAI_SSE : ANTHROPIC_SSE;
    return new Response(payload, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const loggerError = vi.fn();
  const getSettings = vi.fn((): unknown => ({}));
  const getApiKey = vi.fn((): string | undefined => undefined);
  return {
    calls,
    fetchSpy,
    loggerError,
    getSettings,
    getApiKey,
    setMode(mode: ResponseMode) {
      responseMode = mode;
    },
  };
});

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    onSettingsUpdated: vi.fn(),
    getApiKey: harness.getApiKey,
    getSettings: harness.getSettings,
  }),
}));

vi.mock('../../../src/host/model/adapters/aiSdkFetch', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: harness.loggerError,
    debug: vi.fn(),
  },
  makeAiSdkFetch: () => harness.fetchSpy,
}));

const GLM_BASE = {
  provider: 'custom-glm-anthropic',
  model: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  apiKey: 'test',
} as ModelConfig;

function collect() {
  const chunks: StreamChunk[] = [];
  const onStream: StreamCallback = (chunk) => {
    if (typeof chunk !== 'string') chunks.push(chunk);
  };
  return {
    onStream,
    chunks,
    textDeltas: () => chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.content ?? ''),
    reasoning: () => chunks.filter((chunk) => chunk.type === 'reasoning').map((chunk) => chunk.content ?? '').join(''),
  };
}

async function run(config: ModelConfig, options?: InferenceOptions) {
  const col = collect();
  const response = await inferenceViaAiSdk(
    [{ role: 'user', content: '只回复四个字：连通成功' }],
    [],
    config,
    col.onStream,
    undefined,
    options,
  );
  return { response, col };
}

function requestJson(): Record<string, unknown> {
  const raw = harness.calls[0]?.body ?? '';
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body was not an object');
  }
  return value as Record<string, unknown>;
}

beforeEach(() => {
  harness.calls.length = 0;
  harness.fetchSpy.mockClear();
  harness.loggerError.mockClear();
  harness.getApiKey.mockReset();
  harness.getApiKey.mockReturnValue(undefined);
  harness.getSettings.mockReset();
  harness.getSettings.mockReturnValue({});
  harness.setMode('fixture');
});

describe('custom provider protocol=claude 走 Anthropic Messages', () => {
  it('① config.protocol=claude：URL 是 /v1/messages，text_delta 累加进 content', async () => {
    const { response, col } = await run({ ...GLM_BASE, protocol: 'claude' });

    expect(harness.calls.map((call) => call.url)).toEqual([MESSAGES_URL]);
    const body = requestJson();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(typeof body.max_tokens).toBe('number');
    expect(body.stream).toBe(true);
    expect(harness.calls[0]?.url.includes('/chat/completions')).toBe(false);

    const textDeltas = col.textDeltas();
    expect(textDeltas).toEqual(['连通', '成功']);
    expect(response.content).toBe(textDeltas.join(''));
    expect(response.content).toBe('连通成功');
    expect(response.thinking).toBe('用户要求四个字');
    expect(response.content?.includes('用户要求四个字')).toBe(false);
    expect(col.reasoning()).toBe('用户要求四个字');
    expect(col.chunks.some((chunk) => chunk.type === 'text')).toBe(true);
    expect(response.usage).toMatchObject({ inputTokens: 21, outputTokens: 8 });
    expect(col.chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({
      type: 'usage',
      inputTokens: 21,
      outputTokens: 8,
    });
  });

  it('② 协议只写在 settings.providers 里时同样走 /v1/messages', async () => {
    harness.getSettings.mockReturnValue({
      models: {
        providers: {
          'custom-glm-anthropic': { protocol: 'claude' },
        },
      },
    });

    const { response, col } = await run(GLM_BASE);

    expect(harness.calls.map((call) => call.url)).toEqual([MESSAGES_URL]);
    expect(col.textDeltas().join('')).toBe('连通成功');
    expect(response.content).toBe('连通成功');
    expect(response.thinking).toBe('用户要求四个字');
  });

  it('② protocol=openai 的自定义 provider 仍打 /chat/completions', async () => {
    await run(
      { ...GLM_BASE, protocol: 'openai' },
      { disableProviderTransientRetry: true },
    ).catch(() => undefined);

    expect(harness.calls[0]?.url).toContain('/chat/completions');
    expect(harness.calls[0]?.url.includes('/messages')).toBe(false);
  });

  it('② protocol=responses 与 settings 读取失败都保持 /chat/completions', async () => {
    await run(
      { ...GLM_BASE, protocol: 'responses' },
      { disableProviderTransientRetry: true },
    ).catch(() => undefined);
    expect(harness.calls[0]?.url).toContain('/chat/completions');
    expect(harness.calls[0]?.url.includes('/messages')).toBe(false);

    harness.calls.length = 0;
    harness.getSettings.mockImplementation(() => {
      throw new Error('settings down');
    });
    await run(GLM_BASE, { disableProviderTransientRetry: true }).catch(() => undefined);
    expect(harness.calls[0]?.url).toContain('/chat/completions');
    expect(harness.calls[0]?.url.includes('/messages')).toBe(false);
  });

  it('② config.protocol=openai 覆盖 settings 里的 claude', async () => {
    harness.getSettings.mockReturnValue({
      models: { providers: { 'custom-glm-anthropic': { protocol: 'claude' } } },
    });
    await run(
      { ...GLM_BASE, protocol: 'openai' },
      { disableProviderTransientRetry: true },
    ).catch(() => undefined);
    expect(harness.calls[0]?.url).toContain('/chat/completions');
  });

  describe('③ normalizeAnthropicBaseUrl', () => {
    it.each([
      ['https://open.bigmodel.cn/api/anthropic', 'https://open.bigmodel.cn/api/anthropic/v1'],
      ['https://open.bigmodel.cn/api/anthropic/v1', 'https://open.bigmodel.cn/api/anthropic/v1'],
      ['https://open.bigmodel.cn/api/anthropic/v1/', 'https://open.bigmodel.cn/api/anthropic/v1'],
      ['https://open.bigmodel.cn/api/anthropic/', 'https://open.bigmodel.cn/api/anthropic/v1'],
      ['https://api.anthropic.com', 'https://api.anthropic.com/v1'],
      ['https://x.y/v2', 'https://x.y/v2'],
      ['https://x.y/v2/', 'https://x.y/v2'],
      ['https://x.y/api/anthropic?foo=1', 'https://x.y/api/anthropic/v1?foo=1'],
      ['https://x.y/v2?foo=1', 'https://x.y/v2?foo=1'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeAnthropicBaseUrl(input)).toBe(expected);
    });

    it('baseUrl 已带 /v1/ 时请求仍是 /v1/messages，不会拼成 /v1/v1', async () => {
      const { response } = await run({
        ...GLM_BASE,
        protocol: 'claude',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic/v1/',
      });
      expect(harness.calls.map((call) => call.url)).toEqual([MESSAGES_URL]);
      expect(response.content).toBe('连通成功');
    });
  });

  it('④ HTTP 200 的厂商 JSON 不得解析成空的成功响应', async () => {
    harness.setMode('json-200');
    const col = collect();
    const outcome = await inferenceViaAiSdk(
      [{ role: 'user', content: '只回复四个字：连通成功' }],
      [],
      { ...GLM_BASE, protocol: 'claude' },
      col.onStream,
      undefined,
      { disableProviderTransientRetry: true },
    ).then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    const streamedError = col.chunks.some((chunk) => chunk.type === 'error');
    const emptySuccess = outcome.ok
      && (outcome.response.content ?? '') === ''
      && !streamedError;
    expect(outcome.ok === false || streamedError).toBe(true);
    expect(emptySuccess).toBe(false);
  });

  it('④ HTTP 404 拒绝并记下失败日志', async () => {
    harness.setMode('http-404');
    const col = collect();
    const outcome = await inferenceViaAiSdk(
      [{ role: 'user', content: '只回复四个字：连通成功' }],
      [],
      { ...GLM_BASE, protocol: 'claude' },
      col.onStream,
      undefined,
      { disableProviderTransientRetry: true },
    ).then(
      (response) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(outcome.ok).toBe(false);
    expect(harness.loggerError).toHaveBeenCalledWith(
      '[AiSdkAdapter] inference failed',
      expect.objectContaining({
        provider: 'custom-glm-anthropic',
        model: 'glm-5.3',
      }),
    );
  });

  it('⑤ 内置 deepseek / zhipu 仍走 /chat/completions', async () => {
    for (const provider of ['deepseek', 'zhipu'] as const) {
      harness.calls.length = 0;
      await inferenceViaAiSdk(
        [{ role: 'user', content: 'hi' }],
        [],
        { provider, model: 'm', baseUrl: 'https://example.test/v1', apiKey: 'test' } as ModelConfig,
        collect().onStream,
        undefined,
        { disableProviderTransientRetry: true },
      ).catch(() => undefined);
      expect(harness.calls[0]?.url ?? '').toContain('/chat/completions');
      expect(harness.calls[0]?.url ?? '').not.toContain('/messages');
    }
  });
});
