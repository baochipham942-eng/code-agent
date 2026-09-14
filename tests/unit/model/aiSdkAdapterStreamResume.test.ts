// ADR-068 刀 1：首字节后断流续接状态机 —— 锁住：
//  - 断点后第二 attempt 的 accumulator 用断点态 seed：content / reasoning / 完整 toolCalls
//    延续，续写 delta 追加其上；半截 tool_call（JSON.parse 不可过）丢弃不进 seed；
//  - tool_call index 映射跨 attempt 稳定（续写新发的 call 接着断点前序号编）；
//  - abort 不续接（续接退避可中断，醒后回落 throw，不发 error chunk）；
//  - 预算耗尽（STREAM_RECONNECT_MAX 默认 2）回落现有 onStream error + throw；
//  - 429 retry-after 优先于指数退避，且不受续接 4s 封顶；
//  - STREAM_RECONNECT_MAX env 可覆盖；续接退避封顶 4s（env 提高预算后可观测）；
//  - 首字节前重试不回归：见 aiSdkAdapterStream.test.ts 闸门组与 aiSdkAdapterTimeout.test.ts
//    （首字节前用例零改动跑绿即回归证明），本文件不重复覆盖。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamText, generateText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { logger } from '../../../src/host/model/adapters/aiSdkFetch';
import { STREAM_RECONNECT_MAX } from '../../../src/shared/constants';
import type { StreamChunk, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig, ToolDefinition } from '../../../src/shared/contract';

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));
vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => ({ recordSuccess: vi.fn(), recordFailure: vi.fn() }),
}));
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
  outputSchema: { type: 'string' },
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  requiresPermission: false,
  permissionLevel: 'read',
};

/** 用一组受控事件构造 streamText 返回值（只实现被消费的 stream）。 */
function fakeStream(parts: unknown[]) {
  return {
    stream: (async function* () {
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

/** 已吐 delta 后的网络瞬态断流（ECONNRESET，ADR-068 D3 可续接类别）。 */
const BREAK_AFTER_DELTA = [
  { type: 'text-delta', id: 't', text: 'partial' },
  { type: 'error', error: new Error('ECONNRESET') },
];

beforeEach(() => {
  vi.useFakeTimers();
  // 退避带 ±25% jitter（0.75 + random*0.5）：钉住 random=0.5 → jitter 因子 1.0，延迟确定性。
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.STREAM_RECONNECT_MAX;
  vi.resetModules();
});

describe('inferenceViaAiSdk —— 首字节后断流续接（ADR-068 刀 1）', () => {
  it('断点后第二 attempt 携带断点态：text/reasoning/完整 toolCalls 延续，半截 tool_call 丢弃', async () => {
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([
        { type: 'reasoning-delta', id: 'r', text: 'thinking ' },
        { type: 'text-delta', id: 't', text: 'partial' },
        { type: 'tool-input-start', id: 'call_ok', toolName: 'Read' },
        { type: 'tool-input-delta', id: 'call_ok', delta: '{"path":"a.ts"}' },
        { type: 'tool-call', toolCallId: 'call_ok', toolName: 'Read', input: { path: 'a.ts' } },
        // 半截 tool_call：argsText JSON.parse 不可过 → 永不进 seed（D2，判据复用 getIncompleteToolCallIds）
        { type: 'tool-input-start', id: 'call_half', toolName: 'Write' },
        { type: 'tool-input-delta', id: 'call_half', delta: '{"path":"/tm' },
        { type: 'error', error: new Error('ECONNRESET') },
      ]))
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't2', text: ' resumed' },
        { type: 'tool-input-start', id: 'call_new', toolName: 'Read' },
        { type: 'tool-input-delta', id: 'call_new', delta: '{"path":"b.ts"}' },
        { type: 'tool-call', toolCallId: 'call_new', toolName: 'Read', input: { path: 'b.ts' } },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 2, outputTokens: 2 } },
      ]));
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'x' }], [READ_TOOL], CONFIG, col.onStream);
    await vi.advanceTimersByTimeAsync(1000); // 断流 → 续接退避（base 1s × jitter 1.0）
    const res = await p;

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    // 断点态 seed 生效：续写追加在断点内容之后，不是全新累积器
    expect(res.content).toBe('partial resumed');
    expect(res.thinking).toBe('thinking ');
    expect(res.toolCalls).toEqual([
      { id: 'call_ok', name: 'Read', arguments: { path: 'a.ts' } },
      { id: 'call_new', name: 'Read', arguments: { path: 'b.ts' } },
    ]);
    expect(res.contentParts).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'tool_call', toolCallId: 'call_ok' },
      { type: 'text', text: ' resumed' },
      { type: 'tool_call', toolCallId: 'call_new' },
    ]);
    // tool_call index 跨 attempt 稳定（D2）：call_ok=0、call_half=1（断流前已发），
    // 续写新发的 call_new 接 2，不与已 seed 的 index 冲突
    expect(col.byType('tool_call_start').map((c) => c.toolCall?.index)).toEqual([0, 1, 2]);
    // 两次 attempt 的 delta 都对用户 emit（append 语义，renderer 消息不重置）
    expect(col.texts()).toBe('partial resumed');
  });

  it('abort 不续接：续接退避中 abort 立即醒来，不重发、抛原错误、不发 error chunk（abort 永远优先）', async () => {
    vi.mocked(streamText).mockImplementation(() => fakeStream(BREAK_AFTER_DELTA));
    const col = makeCollector();
    const controller = new AbortController();
    // 断流后进入 1000ms 续接退避：25ms 时 abort，应立即醒来且不再重发
    setTimeout(() => controller.abort(), 25);

    const p = inferenceViaAiSdk(
      [{ role: 'user', content: 'x' }],
      [],
      CONFIG,
      col.onStream,
      controller.signal,
    );
    // 先挂 rejection handler 再推进时间：reject 发生在 advance 之后、断言之前，晚了会成 unhandled
    const rejection = expect(p).rejects.toThrow(/ECONNRESET/);
    await vi.advanceTimersByTimeAsync(25); // 触发 abort → 退避立即醒 → 掉出续接分支
    await rejection;

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    expect(col.byType('error')).toHaveLength(0); // aborted 不发 error chunk（现状语义保持）
  });

  it('预算耗尽（默认 2 次续接）→ 回落现有 onStream error + throw 路径', async () => {
    vi.mocked(streamText).mockImplementation(() => fakeStream(BREAK_AFTER_DELTA));
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);
    const settled = p.then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await vi.advanceTimersByTimeAsync(1000); // 续接 #1（index 0 → 1s）
    await vi.advanceTimersByTimeAsync(2000); // 续接 #2（index 1 → 2s）
    const outcome = await settled;

    expect(outcome).toBe('ECONNRESET');
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(3); // 首次 + 2 次续接，预算耗尽不再重发
    expect(col.byType('error')).toHaveLength(1); // 现有 error 呈现路径原样回落
  });

  it('429 尊重 retry-after：优先于指数退避，且不受续接 4s 封顶（等满 7s 才重发）', async () => {
    const err429 = Object.assign(new Error('Too many requests'), { status: 429, retryAfterMs: 7000 });
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't', text: 'partial' },
        { type: 'error', error: err429 },
      ]))
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't', text: 'ok' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]));
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);
    await vi.advanceTimersByTimeAsync(4000); // 4s 续接封顶内不应重发
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000); // retry-after 7000ms 到点才重发
    const res = await p;

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    expect(res.content).toBe('partialok');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('7000ms 后断点续接 (1/2)'));
  });

  it('STREAM_RECONNECT_MAX env 可覆盖预算，且续接退避封顶 4s（第 4 次续接指数 8s 被压到 4s）', async () => {
    process.env.STREAM_RECONNECT_MAX = '4';
    vi.resetModules();
    // resetModules 后模块实例重建：必须用动态 import 拿 fresh 的 mock fn 与 adapter 实例
    const { streamText: streamTextFresh } = await import('ai');
    const { inferenceViaAiSdk: inferFresh } = await import('../../../src/host/model/adapters/aiSdkAdapter');
    const { logger: loggerFresh } = await import('../../../src/host/model/adapters/aiSdkFetch');
    vi.mocked(streamTextFresh).mockImplementation(() => fakeStream(BREAK_AFTER_DELTA));
    const col = makeCollector();

    const p = inferFresh([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);
    const settled = p.then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await vi.advanceTimersByTimeAsync(1000); // 续接 #1（index 0 → 1s）
    await vi.advanceTimersByTimeAsync(2000); // 续接 #2（index 1 → 2s）
    await vi.advanceTimersByTimeAsync(4000); // 续接 #3（index 2 → 4s）
    await vi.advanceTimersByTimeAsync(4000); // 续接 #4（index 3 → 指数 8s，封顶压到 4s）
    const outcome = await settled;

    expect(vi.mocked(streamTextFresh)).toHaveBeenCalledTimes(5); // 首次 + env 预算 4 次续接
    expect(outcome).toBe('ECONNRESET'); // 预算耗尽后回落 throw
    expect(loggerFresh.warn).toHaveBeenCalledWith(expect.stringContaining('4000ms 后断点续接 (4/4)'));
  });

  it('disableProviderTransientRetry：断流续接同受约束，已吐 delta 后也不续接', async () => {
    vi.mocked(streamText).mockImplementation(() => fakeStream(BREAK_AFTER_DELTA));
    const col = makeCollector();

    const p = inferenceViaAiSdk(
      [{ role: 'user', content: 'x' }],
      [],
      CONFIG,
      col.onStream,
      undefined,
      { disableProviderTransientRetry: true },
    );
    const settled = p.then(() => 'resolved', (e: unknown) => (e instanceof Error ? e.message : String(e)));
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await settled;

    expect(outcome).toBe('ECONNRESET');
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1); // 调用方自带重试循环 → 本层单次尝试
  });
});

describe('STREAM_RECONNECT_MAX 常量解析', () => {
  it('默认 2；env 数字覆盖；非数字回落默认（renderer 安全的 typeof 守卫形状）', async () => {
    expect(STREAM_RECONNECT_MAX).toBe(2); // 顶层 import 时无 env

    process.env.STREAM_RECONNECT_MAX = '3';
    vi.resetModules();
    const overridden = await import('../../../src/shared/constants/defaults');
    expect(overridden.STREAM_RECONNECT_MAX).toBe(3);

    process.env.STREAM_RECONNECT_MAX = 'not-a-number';
    vi.resetModules();
    const fallback = await import('../../../src/shared/constants/defaults');
    expect(fallback.STREAM_RECONNECT_MAX).toBe(2); // NaN → 回落默认
    vi.resetModules();
  });
});
