import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openAISSEStream, type StreamSnapshot } from '../../../src/main/model/providers/sseStream';

describe('openAISSEStream snapshot and incomplete tool calls', () => {
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

  it('rejects a stream that ends mid tool-call arguments before DONE', async () => {
    const baseUrl = await startServer((_req, res) => {
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

    await expect(openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      snapshotIntervalMs: 0,
    })).rejects.toThrow(/refusing to execute incomplete tool arguments/);

    expect(snapshots.some(snapshot => (
      !snapshot.isFinal
      && snapshot.toolCalls.some(toolCall => toolCall.id === 'call_1')
    ))).toBe(true);
  });

  it('still returns tool calls when the stream reaches DONE with complete arguments', async () => {
    const baseUrl = await startServer((_req, res) => {
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

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

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
