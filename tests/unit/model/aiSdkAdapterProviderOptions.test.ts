import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { generateText, streamText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';

const providerMocks = vi.hoisted(() => ({
  createDeepSeek: vi.fn(),
  createAnthropic: vi.fn(),
  createOpenAICompatible: vi.fn(),
}));

const resolutionMocks = vi.hoisted(() => ({
  resolveProviderBaseUrl: vi.fn(),
  resolveProviderApiKey: vi.fn(),
}));

const networkMocks = vi.hoisted(() => ({
  getHttpsAgent: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: resolutionMocks.resolveProviderBaseUrl,
  resolveProviderApiKey: resolutionMocks.resolveProviderApiKey,
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));

vi.mock('../../../src/host/model/providers/shared', async (importActual) => ({
  ...(await importActual<typeof import('../../../src/host/model/providers/shared')>()),
  getHttpsAgent: networkMocks.getHttpsAgent,
}));

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: providerMocks.createDeepSeek,
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: providerMocks.createAnthropic,
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: providerMocks.createOpenAICompatible,
}));

vi.mock('axios', () => ({
  default: vi.fn(),
}));

vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

function providerModel(kind: string, options: unknown) {
  return (modelId: string) => ({ kind, modelId, options });
}

function prematurelyClosedStream(chunk: string): Readable {
  let emitted = false;
  return new Readable({
    read() {
      if (emitted) return;
      emitted = true;
      this.push(chunk);
      queueMicrotask(() => this.destroy());
    },
  });
}

async function settleWithin<T>(promise: Promise<T>, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error('stream did not settle within 250ms'));
        }, 250);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runNonStreaming(config: ModelConfig) {
  return inferenceViaAiSdk([{ role: 'user', content: 'hello' }], [], config);
}

beforeEach(() => {
  vi.clearAllMocks();

  resolutionMocks.resolveProviderBaseUrl.mockReturnValue('https://relay.example/v1');
  resolutionMocks.resolveProviderApiKey.mockReturnValue('test-key');
  providerMocks.createDeepSeek.mockImplementation((options) => providerModel('deepseek', options));
  providerMocks.createAnthropic.mockImplementation((options) => providerModel('anthropic', options));
  providerMocks.createOpenAICompatible.mockImplementation((options) => providerModel('compatible', options));
  vi.mocked(generateText).mockResolvedValue({
    text: 'ok',
    toolCalls: [],
    reasoningText: '',
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop',
  } as unknown as Awaited<ReturnType<typeof generateText>>);
});

describe('inferenceViaAiSdk provider options', () => {
  it('DeepSeek 使用 resolveProviderBaseUrl 的 baseURL，并传入 AI SDK custom fetch', async () => {
    resolutionMocks.resolveProviderBaseUrl.mockReturnValue('https://deepseek-relay.example/custom/v1');

    await runNonStreaming({
      provider: 'deepseek',
      model: 'deepseek-chat',
      temperature: 0.7,
    } as ModelConfig);

    expect(providerMocks.createDeepSeek).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      baseURL: 'https://deepseek-relay.example/custom/v1',
      fetch: expect.any(Function),
    }));
  });

  it('Anthropic 和 OpenAI-compatible provider 都接入同一个 custom fetch', async () => {
    await runNonStreaming({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      temperature: 0.4,
    } as ModelConfig);
    await runNonStreaming({
      provider: 'qwen',
      model: 'qwen3-coder-plus',
      temperature: 0.4,
    } as ModelConfig);

    expect(providerMocks.createAnthropic).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'test-key',
      baseURL: 'https://relay.example/v1',
      fetch: expect.any(Function),
    }));
    expect(providerMocks.createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      name: 'qwen',
      apiKey: 'test-key',
      baseURL: 'https://relay.example/v1',
      fetch: expect.any(Function),
    }));
  });

  it('Claude 仅在开启 thinking 且矩阵声明支持时传公开 anthropicBeta option', async () => {
    await runNonStreaming({
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      thinkingBudget: 1024,
    } as ModelConfig);

    expect(vi.mocked(generateText)).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions: {
        anthropic: { anthropicBeta: ['interleaved-thinking-2025-05-14'] },
      },
    }));

    await runNonStreaming({
      provider: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      thinkingBudget: 1024,
    } as ModelConfig);

    expect(vi.mocked(generateText)).toHaveBeenLastCalledWith(expect.not.objectContaining({
      providerOptions: expect.anything(),
    }));
  });

  it('custom fetch 通过 getHttpsAgent/axios 保留 method、headers、body 和 AbortSignal，并返回可读 Response body', async () => {
    const proxyAgent = { tag: 'proxy-agent' };
    networkMocks.getHttpsAgent.mockReturnValue(proxyAgent);
    vi.mocked(axios).mockResolvedValueOnce({
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'x-provider': 'ok' },
      data: Readable.from(['{"ok":', 'true}']),
    });

    // 本例验的是 fetch 管道「原样透传 method/headers/body」，所以必须挑一个矩阵没声明
    // vendor 改写的 provider。用 qwen 会被 transformRequestBody 注入 enable_search，
    // 等于自己拆掉自己的判据。
    await runNonStreaming({
      provider: 'longcat',
      model: 'LongCat-2.0',
      temperature: 0.4,
    } as ModelConfig);

    const fetch = providerMocks.createOpenAICompatible.mock.calls[0][0].fetch as typeof globalThis.fetch;
    const abort = new AbortController();
    const response = await fetch('https://relay.example/v1/chat/completions', {
      method: 'POST',
      headers: [['x-test', '1']],
      body: '{"hello":"world"}',
      signal: abort.signal,
    });

    expect(networkMocks.getHttpsAgent).toHaveBeenCalledWith('https://relay.example/v1/chat/completions', 'longcat');
    expect(vi.mocked(axios)).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://relay.example/v1/chat/completions',
      method: 'POST',
      headers: { 'x-test': '1' },
      data: '{"hello":"world"}',
      signal: abort.signal,
      responseType: 'stream',
      timeout: 0,
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
      proxy: false,
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get('x-provider')).toBe('ok');
    expect(response.body).not.toBeNull();
    await expect(response.text()).resolves.toBe('{"ok":true}');
  });

  it('custom fetch 在源流未 end 就 close 时终结 Web response body', async () => {
    vi.mocked(axios).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      data: prematurelyClosedStream('partial'),
    });

    await runNonStreaming({
      provider: 'qwen',
      model: 'qwen3-coder-plus',
      temperature: 0.4,
    } as ModelConfig);

    const fetch = providerMocks.createOpenAICompatible.mock.calls[0][0].fetch as typeof globalThis.fetch;
    const response = await fetch('https://relay.example/v1/chat/completions');

    await expect(settleWithin(response.text())).rejects.toThrow('AI SDK response stream closed prematurely');
  });

  it('inferenceViaAiSdk 流式路径在源流中途 close 时有限时间内 reject', async () => {
    vi.mocked(axios).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'text/event-stream' },
      data: prematurelyClosedStream('partial'),
    });
    vi.mocked(streamText).mockImplementation((options) => {
      const model = options.model as unknown as { options: { fetch: typeof globalThis.fetch } };
      return {
        stream: (async function* () {
          const response = await model.options.fetch('https://relay.example/v1/chat/completions', {
            signal: options.abortSignal,
          });
          const reader = response.body?.getReader();
          if (!reader) throw new Error('missing response body');
          options.abortSignal?.addEventListener('abort', () => { void reader.cancel(); }, { once: true });
          while (true) {
            const part = await reader.read();
            if (part.done) return;
            yield { type: 'text-delta', id: 'text', text: new TextDecoder().decode(part.value) };
          }
        })(),
      } as unknown as ReturnType<typeof streamText>;
    });
    const controller = new AbortController();

    const inference = inferenceViaAiSdk(
      [{ role: 'user', content: 'hello' }],
      [],
      { provider: 'qwen', model: 'qwen3-coder-plus', temperature: 0.4 } as ModelConfig,
      vi.fn(),
      controller.signal,
      { disableProviderTransientRetry: true },
    );

    await expect(settleWithin(inference, () => controller.abort()))
      .rejects.toThrow('AI SDK response stream closed prematurely');
  });

  it('caller reasoningEffort reaches the final Xiaomi request body before dispatch', async () => {
    vi.mocked(axios).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      data: Readable.from(['{}']),
    });

    await inferenceViaAiSdk([{ role: 'user', content: 'reason' }], [], {
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      reasoningEffort: 'low',
    } as ModelConfig, undefined, undefined, { reasoningEffort: 'high' });

    const fetch = providerMocks.createOpenAICompatible.mock.calls[0][0].fetch as typeof globalThis.fetch;
    await fetch('https://relay.example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'mimo-v2.5-pro', messages: [] }),
    });

    const axiosRequest = vi.mocked(axios).mock.calls[0][0] as { data?: string };
    expect(JSON.parse(axiosRequest.data ?? '{}')).toMatchObject({
      thinking: { type: 'enabled' },
    });
  });

  it('同名模型按 (provider, model) 矩阵分开补 DeepSeek reasoning_content', async () => {
    const history = [
      { role: 'assistant', content: 'plain historical answer' },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      { role: 'user', content: 'continue' },
    ];
    const requestBody = { model: 'deepseek-v4-flash', messages: history };
    vi.mocked(axios).mockResolvedValue({
      status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, data: Readable.from(['{}']),
    });

    await runNonStreaming({ provider: 'deepseek', model: 'deepseek-v4-flash' } as ModelConfig);
    const officialFetch = providerMocks.createDeepSeek.mock.calls[0][0].fetch as typeof globalThis.fetch;
    await officialFetch('https://relay.example/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(requestBody),
    });

    await runNonStreaming({ provider: 'custom-tokenrhythm', model: 'deepseek-v4-flash' } as ModelConfig);
    const relayFetch = providerMocks.createOpenAICompatible.mock.calls[0][0].fetch as typeof globalThis.fetch;
    await relayFetch('https://relay.example/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(requestBody),
    });

    const officialBody = JSON.parse((vi.mocked(axios).mock.calls[0][0] as unknown as { data: string }).data);
    const relayBody = JSON.parse((vi.mocked(axios).mock.calls[1][0] as unknown as { data: string }).data);
    const officialAssistants = officialBody.messages.filter((message: { role: string }) => message.role === 'assistant');
    const relayAssistants = relayBody.messages.filter((message: { role: string }) => message.role === 'assistant');

    expect(officialAssistants).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'plain historical answer', reasoning_content: '' }),
      expect.objectContaining({ tool_calls: expect.any(Array), reasoning_content: '' }),
    ]));
    expect(relayAssistants).toEqual(expect.arrayContaining([
      expect.not.objectContaining({ reasoning_content: expect.anything() }),
    ]));
    expect(relayAssistants).toEqual(history.filter((message) => message.role === 'assistant'));
  });

  it('非流式 generateText 透传 config.maxTokens 为 maxOutputTokens', async () => {
    await runNonStreaming({
      provider: 'qwen',
      model: 'qwen3-coder-plus',
      temperature: 0.4,
      maxTokens: 1234,
    } as ModelConfig);

    expect(vi.mocked(generateText)).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 1234,
    }));
  });

  it('非流式 generateText 对默认温度模型强制使用 temperature=1', async () => {
    await runNonStreaming({
      provider: 'openai',
      model: 'openai/gpt-5.5',
      temperature: 0.7,
    } as ModelConfig);

    expect(vi.mocked(generateText)).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 1,
    }));
  });

  it('AI SDK 工具 schema 不再注入 _meta（全局语义信封已退役，#1131）', async () => {
    const readTool: ToolDefinition = {
      name: 'Read',
      description: 'read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      requiresPermission: false,
      permissionLevel: 'read',
    };

    await inferenceViaAiSdk([{ role: 'user', content: 'read file' }], [readTool], {
      provider: 'qwen',
      model: 'qwen3-coder-plus',
      temperature: 0.4,
    } as ModelConfig);

    const call = vi.mocked(generateText).mock.calls.at(-1)?.[0] as { tools?: Record<string, unknown> };
    const serialized = JSON.stringify(call.tools?.Read);
    // 退役后 schema 只剩工具自己声明的参数：既不能带 _meta，也不能把原参数弄丢。
    expect(serialized).not.toContain('"_meta"');
    expect(serialized).toContain('"path"');
  });

  it('rejects image input before provider construction when the selected model declares no vision support', async () => {
    await expect(inferenceViaAiSdk([{
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
      }],
    }], [], {
      provider: 'deepseek',
      model: 'deepseek-reasoner',
    } as ModelConfig)).rejects.toMatchObject({
      code: 'PROVIDER_RUNTIME_CAPABILITY_BLOCKED',
      capability: 'image_input',
      status: 'unsupported',
    });

    expect(providerMocks.createDeepSeek).not.toHaveBeenCalled();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('rejects unknown local endpoint tool_choice before provider construction', async () => {
    const readTool: ToolDefinition = {
      name: 'Read',
      description: 'read a file',
      inputSchema: { type: 'object', properties: {} },
    } as ToolDefinition;

    await expect(inferenceViaAiSdk(
      [{ role: 'user', content: 'read' }],
      [readTool],
      { provider: 'local', model: 'qwen3:8b' } as ModelConfig,
      undefined,
      undefined,
      { toolChoice: 'required' },
    )).rejects.toMatchObject({
      code: 'PROVIDER_RUNTIME_CAPABILITY_BLOCKED',
      capability: 'tool_choice_required',
      status: 'unknown',
    });

    expect(providerMocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
});
