import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openAISSEStream, type StreamSnapshot } from '../../../src/host/model/providers/sseStream';

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

  it('normalizes cumulative reasoning snapshots before streaming and persisting thinking', async () => {
    const first = '看到屏幕截图分析结果了，当前画面显示 Agent Neo 正在处理图片。';
    const second = `${first} 用户是在追问为什么模型没有收到图片。`;
    const streamedReasoning: string[] = [];
    const snapshots: StreamSnapshot[] = [];
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: first } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: second } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
      onStream: (chunk) => {
        if (typeof chunk !== 'string' && chunk.type === 'reasoning' && chunk.content) {
          streamedReasoning.push(chunk.content);
        }
      },
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      snapshotIntervalMs: 0,
    });

    expect(streamedReasoning.join('')).toBe(second);
    expect(response.thinking).toBe(second);
    expect(snapshots.at(-1)?.reasoning).toBe(second);
  });

  it('rejects repeated reasoning loops before returning poisoned thinking', async () => {
    const repeated = '老公，萌萌看到了，这是我们的聊天记录，显示在 Agent Neo 的界面里。';
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: repeated.repeat(8) } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await expect(openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    })).rejects.toThrow(/reasoning loop detected/);
  });
});
