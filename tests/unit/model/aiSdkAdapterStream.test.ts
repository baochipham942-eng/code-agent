// AI SDK 适配器流式路径 —— 锁住 streamText fullStream 事件 → StreamChunk（项目契约）
// → ModelResponse 的映射，以及 emittedOutput 闸门重试（首字节前才重试、绝不 mid-stream 重试）。
// 主 loop 是 HOT 路径 + 用户可见聊天，这套映射的语义漂移最危险，故用受控事件流单测覆盖。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { streamText, generateText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { StreamChunk, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig, ToolDefinition } from '../../../src/host/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// baseURL/apiKey 解析与本测试无关：固定返回，避免依赖 configService/env。
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));

// provider 健康监控是 app 级单例：桩掉，只验证调用不报错。
vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));

// 只桩掉 streamText / generateText，保留 tool()/jsonSchema 等真实实现（buildTools 依赖）。
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

const CONFIG: ModelConfig = {
  provider: 'xiaomi',
  model: 'mimo-v2.5-pro',
  temperature: 0.7,
} as ModelConfig;

const READ_TOOL: ToolDefinition = {
  name: 'Read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
} as ToolDefinition;

/** 用一组受控事件构造 streamText 返回值（只实现被消费的 fullStream）。 */
function fakeStream(parts: unknown[]) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  } as unknown as ReturnType<typeof streamText>;
}

/** 收集 onStream 回调，按 type 分桶便于断言。 */
function makeCollector() {
  const chunks: StreamChunk[] = [];
  const onStream: StreamCallback = (c) => {
    if (typeof c !== 'string') chunks.push(c);
  };
  return {
    onStream,
    chunks,
    byType: (t: StreamChunk['type']) => chunks.filter((c) => c.type === t),
    texts: () => chunks.filter((c) => c.type === 'text').map((c) => c.content).join(''),
  };
}

beforeEach(() => {
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
});

describe('inferenceViaAiSdk —— 流式映射', () => {
  it('text + 流式 tool-call：逐字 emit + 累积成 tool_use ModelResponse', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'text-delta', id: 't', text: 'Hello ' },
      { type: 'text-delta', id: 't', text: 'world' },
      { type: 'tool-input-start', id: 'call_1', toolName: 'Read' },
      { type: 'tool-input-delta', id: 'call_1', delta: '{"path"' },
      { type: 'tool-input-delta', id: 'call_1', delta: ':"a.ts"}' },
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'Read', input: { path: 'a.ts' } },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 10, outputTokens: 5 } },
    ]));
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [READ_TOOL], CONFIG, col.onStream);

    // onStream 契约
    expect(col.texts()).toBe('Hello world');
    expect(col.byType('tool_call_start')).toEqual([
      { type: 'tool_call_start', toolCall: { index: 0, id: 'call_1', name: 'Read' } },
    ]);
    expect(col.byType('tool_call_delta').map((c) => c.toolCall?.argumentsDelta).join('')).toBe('{"path":"a.ts"}');
    expect(col.byType('usage')[0]).toMatchObject({ type: 'usage', inputTokens: 10, outputTokens: 5 });
    expect(col.byType('complete')[0]).toMatchObject({ type: 'complete', finishReason: 'tool-calls' });

    // ModelResponse 同非流式形状
    expect(res.type).toBe('tool_use');
    expect(res.content).toBe('Hello world');
    expect(res.toolCalls).toEqual([{ id: 'call_1', name: 'Read', arguments: { path: 'a.ts' } }]);
    expect(res.contentParts).toEqual([
      { type: 'text', text: 'Hello world' },
      { type: 'tool_call', toolCallId: 'call_1' },
    ]);
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(res.finishReason).toBe('tool-calls');
  });

  it('流式 streamText 对默认温度模型强制使用 temperature=1', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    const col = makeCollector();

    await inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], {
      ...CONFIG,
      provider: 'openai',
      model: 'openai/gpt-5.5',
      temperature: 0.7,
    } as ModelConfig, col.onStream);

    expect(vi.mocked(streamText)).toHaveBeenCalledWith(expect.objectContaining({
      temperature: 1,
    }));
  });

  it('流式错误事件会把模型配置错误转成可读消息', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      {
        type: 'error',
        error: new Error(
          "litellm.BadRequestError: AzureException BadRequestError - Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.No fallback model group found for original model_group=gpt-5.5.",
        ),
      },
    ]));
    const col = makeCollector();

    await expect(inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], {
      ...CONFIG,
      provider: 'openai',
      model: 'gpt-5.5',
      temperature: 0.7,
    } as ModelConfig, col.onStream)).rejects.toThrow('Unsupported value');

    const errorChunk = col.byType('error')[0];
    expect(errorChunk.error).toContain('模型参数不兼容');
    expect(errorChunk.error).toContain('默认温度 1');
    expect(errorChunk.error).not.toContain('litellm.BadRequestError');
  });

  it('终态 tool-call input 为空时保留已流式累积的参数', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'tool-input-start', id: 'call_write', toolName: 'Write' },
      { type: 'tool-input-delta', id: 'call_write', delta: '{"file_path":"/tmp/demo.html",' },
      { type: 'tool-input-delta', id: 'call_write', delta: '"content":"<h1>ok</h1>"}' },
      { type: 'tool-call', toolCallId: 'call_write', toolName: 'Write', input: {} },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 12, outputTokens: 6 } },
    ]));
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'make html' }], [], CONFIG, col.onStream);

    expect(col.byType('tool_call_delta').map((c) => c.toolCall?.argumentsDelta).join('')).toBe(
      '{"file_path":"/tmp/demo.html","content":"<h1>ok</h1>"}',
    );
    expect(res.toolCalls).toEqual([{
      id: 'call_write',
      name: 'Write',
      arguments: { file_path: '/tmp/demo.html', content: '<h1>ok</h1>' },
    }]);
  });

  it('reasoning + text：thinking 累积、reasoning 实时回调', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'reasoning-delta', id: 'r', text: 'let me think' },
      { type: 'text-delta', id: 't', text: 'answer' },
      { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 3, outputTokens: 2 } },
    ]));
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'q' }], [], CONFIG, col.onStream);

    expect(col.byType('reasoning').map((c) => c.content).join('')).toBe('let me think');
    expect(res.type).toBe('text');
    expect(res.content).toBe('answer');
    expect(res.thinking).toBe('let me think');
    expect(res.toolCalls).toBeUndefined();
  });

  it('provider 不流式工具参数（只发终态 tool-call）：补注册 + 补发 tool_call_start', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'tool-call', toolCallId: 'call_x', toolName: 'Bash', input: { command: 'ls' } },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 1, outputTokens: 1 } },
    ]));
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'run' }], [], CONFIG, col.onStream);

    expect(col.byType('tool_call_start')).toEqual([
      { type: 'tool_call_start', toolCall: { index: 0, id: 'call_x', name: 'Bash' } },
    ]);
    expect(res.toolCalls).toEqual([{ id: 'call_x', name: 'Bash', arguments: { command: 'ls' } }]);
  });

  it('finishReason=length → truncated:true', async () => {
    vi.mocked(streamText).mockReturnValue(fakeStream([
      { type: 'text-delta', id: 't', text: 'cut off' },
      { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 1, outputTokens: 99 } },
    ]));
    const col = makeCollector();
    const res = await inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);
    expect(res.truncated).toBe(true);
    expect(res.finishReason).toBe('length');
  });
});

describe('inferenceViaAiSdk —— emittedOutput 闸门重试', () => {
  it('首字节前瞬态错误（ECONNRESET）：重试一次后成功，无重复 emit', async () => {
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([{ type: 'error', error: new Error('ECONNRESET') }]))
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't', text: 'ok' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]));
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    expect(res.content).toBe('ok');
    expect(col.texts()).toBe('ok'); // 只来自成功那次，无重复
  }, 10_000);

  it('已吐过 delta 后的瞬态错误：绝不 mid-stream 重试，直接抛', async () => {
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't', text: 'Hello' },
        { type: 'error', error: new Error('ECONNRESET') },
      ]))
      .mockReturnValueOnce(fakeStream([{ type: 'text-delta', id: 't', text: 'SHOULD-NOT-RUN' }]));
    const col = makeCollector();

    await expect(
      inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream),
    ).rejects.toThrow(/ECONNRESET/);

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1); // 没重试
    expect(col.texts()).toBe('Hello'); // 用户只看到已吐的部分
    expect(col.byType('error').length).toBeGreaterThan(0);
  });

  it('disableProviderTransientRetry：首字节前失败也不重试', async () => {
    vi.mocked(streamText).mockReturnValueOnce(fakeStream([{ type: 'error', error: new Error('ECONNRESET') }]));
    const col = makeCollector();

    await expect(
      inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream, undefined, {
        disableProviderTransientRetry: true,
      }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
  });

  it('退避等待期间 abort：立即醒来抛原错误，不再等满延迟或重试（codex audit R2 对称应用）', async () => {
    // 每次调用都失败：若错误地重试，第二次调用会被计数捕获
    vi.mocked(streamText).mockImplementation(() =>
      fakeStream([{ type: 'error', error: new Error('ECONNRESET') }]),
    );
    const col = makeCollector();
    const controller = new AbortController();
    // 首次失败后进入 1000ms 退避：25ms 时 abort，应立即醒来
    setTimeout(() => controller.abort(), 25);

    const start = Date.now();
    await expect(
      inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream, controller.signal),
    ).rejects.toThrow(/ECONNRESET/);

    expect(Date.now() - start).toBeLessThan(500); // 没等满 1000ms 退避
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1); // abort 后没有再重试
  });
});

describe('inferenceViaAiSdk —— 路径选择', () => {
  it('forceNonStreaming:true → 走 generateText（非流式），不碰 streamText', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'non-stream',
      toolCalls: [],
      reasoningText: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);
    const col = makeCollector();

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream, undefined, {
      forceNonStreaming: true,
    });

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText)).not.toHaveBeenCalled();
    expect(res.content).toBe('non-stream');
  });

  it('无 onStream → 走 generateText（非流式）', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'no-stream-cb',
      toolCalls: [],
      reasoningText: '',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
    } as unknown as Awaited<ReturnType<typeof generateText>>);

    const res = await inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG);

    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(streamText)).not.toHaveBeenCalled();
    expect(res.content).toBe('no-stream-cb');
  });
});
