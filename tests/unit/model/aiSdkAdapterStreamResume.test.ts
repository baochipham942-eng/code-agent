// ADR-068 刀 1+3：首字节后断流续接状态机与 B2 诚实分段 —— 锁住：
//  - 刀 3 B2（当前一刀的常态，prefix 请求形状是刀 2）：断流重发是全新生成——发
//    stream_break 信号（调用方据此把断点 partial 带中断标记落库），续答 accumulator
//    全新，最终 response 只含续答段；绝不把重发内容 append 进旧消息冒充单次生成（D2）；
//  - B1 断点态 seed（seedAccumulatorFromBreakpoint，经测试钩子直接单测——刀 2 接线前
//    B1 分支不可达）：content / reasoning / 完整 toolCalls 延续；半截 tool_call 丢弃；
//    tool_call index 跨 attempt 稳定；
//  - 刀 3 usage 跨 attempt 合并：单轮 usage = Σ 各次尝试（含断流 attempt 上报过的）；
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

describe('inferenceViaAiSdk —— 首字节后断流续接（ADR-068 刀 1+3）', () => {
  it('刀 3 B2 诚实分段：断流重发是全新生成——发 stream_break，续答 accumulator 全新不拼缝', async () => {
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([
        { type: 'reasoning-delta', id: 'r', text: 'thinking ' },
        { type: 'text-delta', id: 't', text: 'partial' },
        { type: 'tool-input-start', id: 'call_ok', toolName: 'Read' },
        { type: 'tool-input-delta', id: 'call_ok', delta: '{"path":"a.ts"}' },
        { type: 'tool-call', toolCallId: 'call_ok', toolName: 'Read', input: { path: 'a.ts' } },
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
    // B2 分段信号：断流点发出，调用方（loop 层）据此把断点 partial 落库另起一段
    const breaks = col.byType('stream_break');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].error).toBe('ECONNRESET');
    // 续答是全新累积器：response 只含续答段，不含断点片段（D2：跨次生成不拼进同一条消息）
    expect(res.content).toBe(' resumed');
    expect(res.thinking).toBeUndefined();
    expect(res.toolCalls).toEqual([
      { id: 'call_new', name: 'Read', arguments: { path: 'b.ts' } },
    ]);
    expect(res.contentParts).toEqual([
      { type: 'text', text: ' resumed' },
      { type: 'tool_call', toolCallId: 'call_new' },
    ]);
    // 续答 tool_call 从新消息自己的 0 号 index 起（断点的 call 已随 partial 交给调用方）
    expect(col.byType('tool_call_start').map((c) => c.toolCall?.index)).toEqual([0, 0]);
    // 两次 attempt 的 delta 都照常 emit（append 通道的分离是 loop 层职责，见其单测）
    expect(col.texts()).toBe('partial resumed');
  });

  it('刀 3 usage 跨 attempt 合并：单轮 usage = Σ 各次尝试（断流 attempt 报过的 usage 并入）', async () => {
    vi.mocked(streamText)
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't', text: 'partial' },
        // finish 先到、流随后断：该 attempt 的 usage 已上报，属真实计费
        // （AI SDK usage 形状：cache 细节在 inputTokenDetails，inputTokens 为含缓存总量）
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 16, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 6, noCacheTokens: 10 } } },
        { type: 'error', error: new Error('ECONNRESET') },
      ]))
      .mockReturnValueOnce(fakeStream([
        { type: 'text-delta', id: 't2', text: 'ok' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 20, outputTokens: 5, inputTokenDetails: { cacheWriteTokens: 3, noCacheTokens: 20 } } },
      ]));
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'x' }], [], CONFIG, col.onStream);
    await vi.advanceTimersByTimeAsync(1000);
    const res = await p;

    expect(res.usage).toEqual({
      inputTokens: 30, // 10 + 20：两次尝试的 input 都是真实花费
      outputTokens: 9, // 4 + 5
      cacheReadTokens: 6, // 仅第一次上报
      cacheCreationTokens: 3, // 仅第二次上报
    });
    // 展示层单轮 usage 事件也发合并后的总额
    const usageChunks = col.byType('usage');
    expect(usageChunks).toHaveLength(1);
    expect(usageChunks[0]).toMatchObject({ inputTokens: 30, outputTokens: 9 });
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
    expect(res.content).toBe('ok'); // B2：续答段 only，断点片段由调用方分段落库
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

describe('seedAccumulatorFromBreakpoint —— B1 断点态 seed（ADR-068 刀 1，测试钩子直达）', () => {
  // B1 分支在刀 2（prefix 请求形状）接线前不可达（STREAM_RESUME_B1_PREFIX_SHAPE_LANDED
  // 恒 false，一切续接走 B2），断点态行为靠挂在 inferenceViaAiSdk 上的测试钩子锁住；
  // 刀 2 翻开关后由端到端用例接管。StreamAccumulator 不是公开类型，这里按需描形。
  type SeedAcc = {
    content: string; reasoning: string; charCount: number; nextToolIndex: number;
    finishReason?: string; usage?: unknown; lastPartType: 'text' | 'tool_call' | null;
    contentParts: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCallId: string }>;
    toolCalls: Map<string, { id: string; name: string; argsText: string; input?: Record<string, unknown>; index: number }>;
  };
  type SeedResult = Pick<SeedAcc, 'content' | 'reasoning' | 'contentParts' | 'toolCalls' | 'nextToolIndex' | 'finishReason' | 'usage'>;
  const seed = (inferenceViaAiSdk as { __seedAccumulatorFromBreakpoint?: (acc: SeedAcc) => SeedResult }).__seedAccumulatorFromBreakpoint;

  it('content/reasoning/完整 toolCalls 延续；半截 tool_call 丢弃；index 跨 attempt 稳定', () => {
    const acc: SeedAcc = {
      content: 'partial',
      reasoning: 'thinking ',
      finishReason: undefined,
      usage: undefined,
      toolCalls: new Map([
        ['call_ok', { id: 'call_ok', name: 'Read', argsText: '', input: { path: 'a.ts' }, index: 0 }],
        // 半截：argsText JSON.parse 不可过 → 永不进 seed（D2，判据复用 getIncompleteToolCallIds）
        ['call_half', { id: 'call_half', name: 'Write', argsText: '{"path":"/tm', index: 1 }],
      ]),
      contentParts: [
        { type: 'text', text: 'partial' },
        { type: 'tool_call', toolCallId: 'call_ok' },
        { type: 'tool_call', toolCallId: 'call_half' },
      ],
      lastPartType: 'tool_call',
      charCount: 7,
      nextToolIndex: 2,
    };
    const seeded = seed!(acc);

    expect(seeded.content).toBe('partial');
    expect(seeded.reasoning).toBe('thinking ');
    expect([...seeded.toolCalls.keys()]).toEqual(['call_ok']); // 半截丢弃
    expect(seeded.contentParts).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'tool_call', toolCallId: 'call_ok' }, // 半截的 contentParts 条目一并移除
    ]);
    // 断点处未 finish：终态字段不带入（usage 账在 streamViaAiSdk 的合并变量上）
    expect(seeded.finishReason).toBeUndefined();
    expect(seeded.usage).toBeUndefined();
    // index 映射跨 attempt 稳定（D2）：续写新发的 tool_call 接着断点前序号编
    expect(seeded.nextToolIndex).toBe(2);
  });
});
