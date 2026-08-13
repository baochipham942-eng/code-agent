import http from 'node:http';
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

describe('ClaudeProvider tool-call streaming order', () => {
  it('在 tool_call delta 前下发已生成的 preamble 文本', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '我先读取文件。' } });
      send('content_block_stop', { index: 0 });
      send('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} } });
      send('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } });
      send('content_block_stop', { index: 1 });
      send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
      send('message_stop', {});
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected server address');
    const events: Array<{ type?: string; content?: string }> = [];

    try {
      await new ClaudeProvider().inference([{ role: 'user', content: '读取文件' }], [], {
        ...BASE_CONFIG,
        baseUrl: `http://127.0.0.1:${address.port}`,
      }, (event) => { if (typeof event !== 'string') events.push(event); });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const preambleAt = events.findIndex((event) => event.type === 'text' && event.content === '我先读取文件。');
    const toolDeltaAt = events.findIndex((event) => event.type === 'tool_call_delta');
    expect(preambleAt).toBeGreaterThanOrEqual(0);
    expect(toolDeltaAt).toBeGreaterThan(preambleAt);
  });
});
