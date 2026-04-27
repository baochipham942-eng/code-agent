import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StreamSnapshot } from '../../../src/main/model/providers/sseStream';

const cloudProxyState = vi.hoisted(() => ({
  baseUrl: '',
}));

vi.mock('../../../src/shared/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../src/shared/constants')>('../../../src/shared/constants');
  return {
    ...actual,
    getCloudApiUrl: () => cloudProxyState.baseUrl,
  };
});

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('cloud proxy streaming snapshots', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function startServer(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('unexpected server address');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it('rejects incomplete streamed tool arguments before DONE and emits an unstable snapshot', async () => {
    cloudProxyState.baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: {
                name: 'write_file',
                arguments: '{"file_path":"/tmp/pwned"',
              },
            }],
          },
        }],
      })}\n\n`);
      res.end();
    });
    const snapshots: StreamSnapshot[] = [];
    const { callViaCloudProxy } = await import('../../../src/main/model/providers/cloud-proxy');

    await expect(callViaCloudProxy(
      [{ role: 'user', content: 'write' }],
      [],
      { provider: 'openai', model: 'gpt-test', useCloudProxy: true },
      { id: 'gpt-test', name: 'GPT Test', supportsTool: true } as any,
      vi.fn(),
      undefined,
      { onSnapshot: (snapshot) => snapshots.push(snapshot), snapshotIntervalMs: 0 },
    )).rejects.toThrow(/refusing to execute incomplete tool arguments/);

    expect(snapshots.some(snapshot => (
      !snapshot.isFinal
      && snapshot.toolCalls.some(toolCall => toolCall.id === 'call_1' && toolCall.name === 'write_file')
    ))).toBe(true);
  });

  it('returns tool calls only after DONE with complete arguments', async () => {
    cloudProxyState.baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: {
                name: 'read_file',
                arguments: '{"file_path":"package.json"}',
              },
            }],
          },
        }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const { callViaCloudProxy } = await import('../../../src/main/model/providers/cloud-proxy');

    const response = await callViaCloudProxy(
      [{ role: 'user', content: 'read' }],
      [],
      { provider: 'openai', model: 'gpt-test', useCloudProxy: true },
      { id: 'gpt-test', name: 'GPT Test', supportsTool: true } as any,
      vi.fn(),
    );

    expect(response).toMatchObject({
      type: 'tool_use',
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { file_path: 'package.json' },
      }],
    });
  });
});
