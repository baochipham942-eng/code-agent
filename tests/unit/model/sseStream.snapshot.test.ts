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

  it('rejects a [DONE] stream whose tool arguments were truncated by finish_reason:length', async () => {
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
          finish_reason: 'length',
        }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await expect(openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    })).rejects.toThrow(/refusing to execute incomplete tool arguments/);
  });

  it('still returns a complete tool call when the stream ends before [DONE] without a finish_reason', async () => {
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
      res.end(); // 干净关闭，无 [DONE]，也没有 finish_reason
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response).toMatchObject({
      type: 'tool_use',
      // finishReason 缺失 → 保守判截断（computeTruncated：双重异常终止，JSON 合法 ≠ 语义完整）。
      // 工具路径与文本路径共用同一判定；有明确 finish_reason:'stop'/'tool_calls' 时才 false。
      truncated: true,
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { file_path: 'package.json' },
      }],
    });
  });

  it('marks truncated:false for a complete tool call that ends before [DONE] with finish_reason:tool_calls', async () => {
    // 有明确的结束信号（tool_calls）+ 参数完整 → 不是截断，避免 messageProcessor 把完整工具
    // （尤其 Bash heredoc）当截断跳过执行。
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
          finish_reason: 'tool_calls',
        }],
      })}\n\n`);
      res.end(); // 干净关闭，无 [DONE]
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response).toMatchObject({
      type: 'tool_use',
      truncated: false,
      toolCalls: [{
        id: 'call_1',
        name: 'read_file',
        arguments: { file_path: 'package.json' },
      }],
    });
  });

  it('rejects an empty-arg tool call when the stream ends without any finish_reason', async () => {
    // "发了工具名、参数一字未发、连接以 [DONE] 收尾但从未携带 finish_reason" 与合法零参工具在 wire 上
    // 无法区分——缺失 finish_reason 是最不可信的结束信号，与 computeTruncated 一致按截断处理：判不完整拒掉，
    // 不能带 {} 默认参数静默执行（enter_plan_mode 等无 required 字段工具会真跑）。合法零参工具走
    // 明确的 finish_reason:'stop'/'tool_calls' 路径（见下一条用例）。
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
                name: 'enter_plan_mode',
                arguments: '',
              },
            }],
          },
        }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await expect(openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    })).rejects.toThrow(/refusing to execute incomplete tool arguments/);
  });

  it('rejects a zero-arg-shaped empty tool call truncated by finish_reason:length before first arg token', async () => {
    // 模型发了工具名、还没发第一个参数 token 就撞 length 截断——arguments 也是空串，
    // 但这是真截断，不能放过（否则会带默认参数执行，如 enter_plan_mode 无 required 字段且改运行状态）。
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
              function: { name: 'enter_plan_mode', arguments: '' },
            }],
          },
          finish_reason: 'length',
        }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await expect(openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    })).rejects.toThrow(/refusing to execute incomplete tool arguments/);
  });

  it('resolves an empty zero-arg tool call when finish_reason is stop', async () => {
    // 空串 + 正常 'stop' 收尾 → 无参工具正常放行，arguments 为 {}。
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
              function: { name: 'task_list', arguments: '' },
            }],
          },
          finish_reason: 'stop',
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
      truncated: false,
      toolCalls: [{ id: 'call_1', name: 'task_list' }],
    });
    // F1 承重断言：空串必须精确解析成 {}，而非 safeJsonParse('') 的 {__parseError:true,...} 脏对象。
    // 用 toEqual（拒绝多余 key），toMatchObject({}) 会对脏对象也放行 → 测不到 F1。
    expect(response.toolCalls?.[0]?.arguments).toEqual({});
  });

  it('marks truncated:true for finish_reason:max_tokens on a [DONE] stream', async () => {
    // 下游 messageProcessor 把 length 和 max_tokens 都当截断；只判 'length' 会漏掉 max_tokens。
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'partial answer' }, finish_reason: 'max_tokens' }],
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

    expect(response).toMatchObject({ type: 'text', truncated: true });
  });

  it('marks truncated:true for finish_reason:max_tokens when the stream ends before [DONE]', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'partial answer' }, finish_reason: 'max_tokens' }],
      })}\n\n`);
      res.end(); // 无 [DONE]
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response).toMatchObject({ type: 'text', truncated: true });
  });

  it('marks truncated:false for pure text with finish_reason:stop and no [DONE]', async () => {
    // 模型明确 'stop' 收尾（只是没等到 [DONE]），纯文本不该被误判截断触发重复续写。
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'complete answer' }, finish_reason: 'stop' }],
      })}\n\n`);
      res.end(); // 无 [DONE]
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response).toMatchObject({ type: 'text', truncated: false });
    expect(response.content).toBe('complete answer');
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

  it('folds an unclosed <think> block into thinking instead of leaking raw reasoning into content on DONE', async () => {
    // 真实事故：流式响应命中 length 截断时 <think> 可能没等到闭合标签就结束，
    // 未闭合的推理原文如果留在 content 里会绕过思考折叠机制，原样摊在转录里当"正文"显示。
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: '<think>Long chain of reasoning that never closes' } }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'length' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response.content).toBeFalsy();
    expect(response.thinking).toBe('Long chain of reasoning that never closes');
  });

  it('folds an unclosed <think> block into thinking when the stream ends abruptly before DONE', async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: '<think>Reasoning cut off by a dropped connection' } }],
      })}\n\n`);
      res.end();
    });

    const response = await openAISSEStream({
      providerName: 'TestProvider',
      baseUrl,
      apiKey: 'test-key',
      requestBody: { model: 'test', messages: [], stream: true },
    });

    expect(response.content).toBeFalsy();
    expect(response.thinking).toBe('Reasoning cut off by a dropped connection');
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
