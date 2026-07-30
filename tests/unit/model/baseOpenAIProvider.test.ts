import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { BaseOpenAIProvider } from '../../../src/host/model/providers/baseOpenAIProvider';
import { electronFetch } from '../../../src/host/model/providers/shared';
import { getModelAuthFailureMarker } from '../../../src/host/model/errorClassifier';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }),
}));

vi.mock('../../../src/host/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/model/providers/shared')>(
    '../../../src/host/model/providers/shared',
  );
  return {
    ...actual,
    electronFetch: vi.fn(),
  };
});

class TestOpenAIProvider extends BaseOpenAIProvider {
  readonly name = 'TestOpenAI';

  protected getBaseUrl(): string {
    return 'https://example.test/v1';
  }

  protected getApiKey(): string {
    return 'test-key';
  }
}

const mockElectronFetch = vi.mocked(electronFetch);

describe('BaseOpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries transient failures for non-streaming requests', async () => {
    mockElectronFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          choices: [
            {
              message: {
                content: 'recovered',
              },
            },
          ],
        }),
      } as any);

    const provider = new TestOpenAIProvider();
    const config: ModelConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      maxTokens: 1000,
    };

    const result = await provider.inference(
      [{ role: 'user', content: 'write an html game' }],
      [],
      config,
      undefined,
      undefined,
      { forceNonStreaming: true },
    );

    expect(result).toMatchObject({ type: 'text', content: 'recovered' });
    expect(mockElectronFetch).toHaveBeenCalledTimes(2);
    expect(mockElectronFetch).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({ provider: 'openai' }),
    );
  });

  it('honors disabled transient retry for non-streaming requests', async () => {
    mockElectronFetch.mockRejectedValue(new Error('socket hang up'));

    const provider = new TestOpenAIProvider();
    const config: ModelConfig = {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      maxTokens: 1000,
    };

    await expect(
      provider.inference(
        [{ role: 'user', content: 'write an html game' }],
        [],
        config,
        undefined,
        undefined,
        { forceNonStreaming: true, disableProviderTransientRetry: true },
      ),
    ).rejects.toThrow('socket hang up');

    expect(mockElectronFetch).toHaveBeenCalledTimes(1);
    expect(mockElectronFetch).toHaveBeenCalledWith(
      'https://example.test/v1/chat/completions',
      expect.objectContaining({ provider: 'openai' }),
    );
  });

  // 批 X5 ③：鉴权失败要变成用户看得懂的一句人话，而判据只能是结构化字段——
  // 上游那句 `You didn't provide an API key...` 是它自己的自由文案，按文本认必然漏。
  // 这里钉的是**生产者真的把 status 带出来了**（此前 status 只存在于 message 文本里，
  // errorClassifier 的整条 status 判据对这条路径形同虚设）。
  it('鉴权失败（401）把 status/provider/model 带在错误对象上，可被结构化识别', async () => {
    mockElectronFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"You didn\'t provide an API key."}}',
      json: async () => ({}),
    } as never);

    const provider = new TestOpenAIProvider();
    const config: ModelConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key', maxTokens: 1000 };

    const error = await provider.inference(
      [{ role: 'user', content: 'hi' }], [], config, undefined, undefined,
      { forceNonStreaming: true, disableProviderTransientRetry: true },
    ).catch((err: unknown) => err);

    expect(getModelAuthFailureMarker(error)).toEqual({
      code: 'MODEL_AUTH',
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('本地就没有 key 时抛自有 code，同样识别为鉴权失败', async () => {
    class NoKeyProvider extends TestOpenAIProvider {
      protected override getApiKey(): string {
        return '';
      }
    }
    const config: ModelConfig = { provider: 'openai', model: 'gpt-4o', apiKey: '', maxTokens: 1000 };

    const error = await new NoKeyProvider()
      .inference([{ role: 'user', content: 'hi' }], [], config)
      .catch((err: unknown) => err);

    expect(getModelAuthFailureMarker(error)).toMatchObject({ code: 'MODEL_AUTH', provider: 'openai' });
    expect(mockElectronFetch).not.toHaveBeenCalled();
  });

  it('非鉴权失败（500）不冒充缺 key', async () => {
    mockElectronFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
      json: async () => ({}),
    } as never);

    const config: ModelConfig = { provider: 'openai', model: 'gpt-4o', apiKey: 'test-key', maxTokens: 1000 };
    const error = await new TestOpenAIProvider().inference(
      [{ role: 'user', content: 'hi' }], [], config, undefined, undefined,
      { forceNonStreaming: true, disableProviderTransientRetry: true },
    ).catch((err: unknown) => err);

    expect(getModelAuthFailureMarker(error)).toBeUndefined();
  });
});
