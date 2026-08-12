import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../../src/shared/contract';
import { ClaudeProvider } from '../../../src/host/model/providers/claudeProvider';
import { electronFetch } from '../../../src/host/model/providers/shared';

vi.mock('../../../src/host/model/providers/shared', async () => {
  const actual = await vi.importActual<typeof import('../../../src/host/model/providers/shared')>(
    '../../../src/host/model/providers/shared',
  );
  return {
    ...actual,
    electronFetch: vi.fn(),
  };
});

const mockElectronFetch = vi.mocked(electronFetch);

const BASE_CONFIG: ModelConfig = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  apiKey: 'test-key',
  promptCaching: { enabled: false },
};

function mockSuccessfulResponse() {
  mockElectronFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  } as never);
}

async function infer(config: ModelConfig) {
  await new ClaudeProvider().inference([{ role: 'user', content: 'hello' }], [], config);
  return mockElectronFetch.mock.calls[0][1]?.headers;
}

describe('ClaudeProvider interleaved thinking beta header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulResponse();
  });

  it('includes interleaved-thinking beta when extended thinking is enabled on a supported model', async () => {
    const headers = await infer({ ...BASE_CONFIG, reasoningEffort: 'low' });

    expect(headers?.['anthropic-beta'] ?? '').toContain('interleaved-thinking-2025-05-14');
  });

  it('does not include interleaved-thinking beta when extended thinking is disabled', async () => {
    const headers = await infer(BASE_CONFIG);

    expect(headers?.['anthropic-beta'] ?? '').not.toContain('interleaved-thinking-2025-05-14');
  });

  // 矩阵驱动的意义就在这条：能力表里没声明的模型，即使开了 thinking 也不该被发这个 beta。
  // 少了它，把查表换回「所有 claude 模型都发」也照样全绿。
  it('does not include interleaved-thinking beta on a model the matrix does not declare', async () => {
    const headers = await infer({ ...BASE_CONFIG, model: 'claude-3-5-sonnet-20241022', reasoningEffort: 'low' });

    expect(headers?.['anthropic-beta'] ?? '').not.toContain('interleaved-thinking-2025-05-14');
  });
});
