import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { BaseOpenAIProvider } from '../../../src/main/model/providers/baseOpenAIProvider';
import { electronFetch } from '../../../src/main/model/providers/shared';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/main/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  }),
}));

vi.mock('../../../src/main/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/model/providers/shared')>(
    '../../../src/main/model/providers/shared',
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
  });
});
