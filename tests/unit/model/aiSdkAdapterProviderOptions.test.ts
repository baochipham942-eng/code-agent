import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { generateText } from 'ai';
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

  it('custom fetch 通过 getHttpsAgent/axios 保留 method、headers、body 和 AbortSignal，并返回可读 Response body', async () => {
    const proxyAgent = { tag: 'proxy-agent' };
    networkMocks.getHttpsAgent.mockReturnValue(proxyAgent);
    vi.mocked(axios).mockResolvedValueOnce({
      status: 201,
      statusText: 'Created',
      headers: { 'content-type': 'application/json', 'x-provider': 'ok' },
      data: Readable.from(['{"ok":', 'true}']),
    });

    await runNonStreaming({
      provider: 'qwen',
      model: 'qwen3-coder-plus',
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

    expect(networkMocks.getHttpsAgent).toHaveBeenCalledWith('https://relay.example/v1/chat/completions', 'qwen');
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

  it('AI SDK 工具 schema 复用旧 OpenAI 路径的 _meta 注入', async () => {
    const readTool: ToolDefinition = {
      name: 'Read',
      description: 'read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    } as ToolDefinition;

    await inferenceViaAiSdk([{ role: 'user', content: 'read file' }], [readTool], {
      provider: 'qwen',
      model: 'qwen3-coder-plus',
      temperature: 0.4,
    } as ModelConfig);

    const call = vi.mocked(generateText).mock.calls.at(-1)?.[0] as { tools?: Record<string, unknown> };
    expect(JSON.stringify(call.tools?.Read)).toContain('"_meta"');
  });
});
