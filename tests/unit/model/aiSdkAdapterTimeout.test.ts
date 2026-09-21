// AI SDK 适配器 per-request 超时 —— 锁住迁移时丢失、现已补回的超时契约：
//  - 非流式 generateText：requestTimeoutMs 到点 abort 本次请求 → 抛 'timeout of …' → withTransientRetry 重试。
//  - 流式 streamText：firstByteTimeoutMs（首字节前卡住→重试）+ inactivityTimeoutMs（已出 delta 后卡住→断点续接，ADR-068 D3）。
// 背景：旧 axios/sseStream 路径有 PROVIDER_TIMEOUT/SSE_FIRST_BYTE/SSE_INACTIVITY；AI SDK 走 fetch 无默认超时，
// 迁移漏带 → provider 卡住会一直挂到外层预算（子代理 90s 硬超时）耗尽，无 per-request 早退+重试。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamText, generateText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { StreamChunk, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract';

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

// 一个永不返回、直到 abortSignal 触发才 reject 的 promise（模拟 provider 卡住）。
function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function streamOf(parts: unknown[]) {
  return { stream: (async function* () { for (const p of parts) yield p; })() } as unknown as ReturnType<typeof streamText>;
}
function hangingStream(signal: AbortSignal | undefined, leadingParts: unknown[] = []) {
  return {
    stream: (async function* () {
      for (const p of leadingParts) yield p;
      await hangUntilAbort(signal);
    })(),
  } as unknown as ReturnType<typeof streamText>;
}

function makeCollector() {
  const chunks: StreamChunk[] = [];
  const onStream: StreamCallback = (c) => { if (typeof c !== 'string') chunks.push(c); };
  return { onStream, chunks, byType: (t: StreamChunk['type']) => chunks.filter((c) => c.type === t) };
}

beforeEach(() => {
  vi.useFakeTimers();
  // 退避带 ±25% jitter（0.75 + random*0.5）：钉住 random=0.5 → jitter 因子 1.0，延迟确定性。
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('inferenceViaAiSdk —— per-request 超时 + 重试', () => {
  it('非流式：请求卡住到 requestTimeoutMs → 抛 timeout → withTransientRetry 重试，第二次成功', async () => {
    let calls = 0;
    vi.mocked(generateText).mockImplementation((opts: Parameters<typeof generateText>[0]) => {
      calls += 1;
      if (calls === 1) return hangUntilAbort((opts as { abortSignal?: AbortSignal }).abortSignal);
      return Promise.resolve({
        text: 'recovered', toolCalls: [], reasoningText: '',
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);
    });

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, undefined, undefined, { requestTimeoutMs: 1000 });
    // 1000ms: per-request 看门狗 abort 第一次请求；之后 withTransientRetry 退避（baseDelay 1000ms）后重试。
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(calls).toBe(2);
    expect(result.content).toBe('recovered');
  });

  it('流式：首字节前卡住到 firstByteTimeoutMs → first-byte timeout → 重试（emittedOutput 闸门允许），第二次出字', async () => {
    let calls = 0;
    vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
      calls += 1;
      if (calls === 1) return hangingStream((opts as { abortSignal?: AbortSignal }).abortSignal);
      return streamOf([
        { type: 'text-delta', id: 't', text: 'hello' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    });
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream, undefined, { firstByteTimeoutMs: 1000, inactivityTimeoutMs: 9000 });
    await vi.advanceTimersByTimeAsync(1000); // first-byte 看门狗 abort 第一次
    await vi.advanceTimersByTimeAsync(1000); // 流式重试退避 STREAM_RETRY_BASE_DELAY_MS
    const result = await p;

    expect(calls).toBe(2);
    expect(result.content).toBe('hello');
  });

  it('流式：已出 delta 后卡住到 inactivityTimeoutMs → stream inactivity timeout → 断点续接（ADR-068 D3 主场景），断点态延续', async () => {
    let calls = 0;
    vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
      calls += 1;
      // 先吐一个 delta（emittedOutput=true），随后卡住。
      if (calls === 1) return hangingStream((opts as { abortSignal?: AbortSignal }).abortSignal, [{ type: 'text-delta', id: 't', text: 'partial' }]);
      return streamOf([
        { type: 'text-delta', id: 't', text: 'resumed' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    });
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream, undefined, { firstByteTimeoutMs: 9000, inactivityTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000); // inactivity 看门狗 abort 第一次（已吐 delta → 走续接）
    await vi.advanceTimersByTimeAsync(1000); // 续接退避（base 1s × jitter 1.0）
    const result = await p;

    expect(calls).toBe(2);
    // 刀 3 B2 诚实分段：response 只含续答段，断点片段由调用方带中断标记分段落库；
    // stream_break 信号在断流点发出（D3 主场景的形态从 append 续写改为分段续答）
    expect(result.content).toBe('resumed');
    expect(col.byType('stream_break')).toHaveLength(1);
    expect(col.byType('error').length).toBe(0); // 续接成功，无 error
  });

  it('非流式：连续挂起 → 客户端超时重试帽（2 次）耗尽后抛错，不再烧第 3 个请求窗口（issue #1989 失败路径）', async () => {
    let calls = 0;
    vi.mocked(generateText).mockImplementation((opts: Parameters<typeof generateText>[0]) => {
      calls += 1;
      return hangUntilAbort((opts as { abortSignal?: AbortSignal }).abortSignal);
    });
    const retryInfos: Array<{ kind: string; attempt: number; maxRetries: number }> = [];

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, undefined, undefined, {
      requestTimeoutMs: 1000,
      onInferenceRetry: (info) => retryInfos.push(info),
    });
    const assertion = expect(p).rejects.toThrow('timeout of 1000ms exceeded');
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次请求超时 → 重试 1（退避 1s）
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // 第 2 次请求超时 → 重试 2（退避 2s）
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000); // 第 3 次请求超时 → 帽满，放弃
    await assertion;

    expect(calls).toBe(3); // 1 + 2 次超时重试，不是 1 + GENERATE_MAX_RETRIES
    expect(retryInfos).toHaveLength(2);
    expect(retryInfos.every((i) => i.kind === 'timeout')).toBe(true);
  });

  it('非流式：普通瞬态错误（503）不受超时重试帽影响，仍按 GENERATE_MAX_RETRIES 重试', async () => {
    let calls = 0;
    vi.mocked(generateText).mockImplementation(() => {
      calls += 1;
      if (calls <= 2) return Promise.reject(Object.assign(new Error('Service Unavailable'), { status: 503 }));
      return Promise.resolve({
        text: 'recovered', toolCalls: [], reasoningText: '',
        usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop',
      } as unknown as Awaited<ReturnType<typeof generateText>>);
    });
    const retryInfos: Array<{ kind: string }> = [];

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, undefined, undefined, {
      requestTimeoutMs: 60_000,
      onInferenceRetry: (info) => retryInfos.push(info),
    });
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次 503 → 退避 1s
    await vi.advanceTimersByTimeAsync(2000); // 第 2 次 503 → 退避 2s
    const result = await p;

    expect(calls).toBe(3);
    expect(result.content).toBe('recovered');
    expect(retryInfos).toHaveLength(2);
    expect(retryInfos.every((i) => i.kind === 'transient')).toBe(true);
  });

  it('流式：首字节连续挂起 → 首字节超时重试帽（2 次）耗尽后抛错（issue #1989 失败路径）', async () => {
    let calls = 0;
    vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
      calls += 1;
      return hangingStream((opts as { abortSignal?: AbortSignal }).abortSignal);
    });
    const col = makeCollector();
    const retryInfos: Array<{ kind: string }> = [];

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream, undefined, {
      firstByteTimeoutMs: 1000,
      inactivityTimeoutMs: 9000,
      onInferenceRetry: (info) => retryInfos.push(info),
    });
    const assertion = expect(p).rejects.toThrow('first-byte timeout');
    await vi.advanceTimersByTimeAsync(1000); // 第 1 次首字节超时 → 重试 1（退避 1s）
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // 第 2 次首字节超时 → 重试 2（退避 2s）
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000); // 第 3 次首字节超时 → 帽满，放弃
    await assertion;

    expect(calls).toBe(3);
    expect(retryInfos).toHaveLength(2);
    expect(retryInfos.every((i) => i.kind === 'timeout')).toBe(true);
    expect(col.byType('error')).toHaveLength(1); // 终错经 streamCallback error 分支可见，不静默
  });

  it('流式：断流续接时 onInferenceRetry 以 kind=reconnect 上报（trace 可见性）', async () => {
    let calls = 0;
    vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
      calls += 1;
      if (calls === 1) return hangingStream((opts as { abortSignal?: AbortSignal }).abortSignal, [{ type: 'text-delta', id: 't', text: 'partial' }]);
      return streamOf([
        { type: 'text-delta', id: 't', text: 'resumed' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    });
    const col = makeCollector();
    const retryInfos: Array<{ kind: string; attempt: number; maxRetries: number }> = [];

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream, undefined, {
      firstByteTimeoutMs: 9000,
      inactivityTimeoutMs: 1000,
      onInferenceRetry: (info) => retryInfos.push(info),
    });
    await vi.advanceTimersByTimeAsync(1000); // inactivity 看门狗 → 断点续接
    await vi.advanceTimersByTimeAsync(1000); // 续接退避
    const result = await p;

    expect(result.content).toBe('resumed');
    expect(retryInfos).toHaveLength(1);
    expect(retryInfos[0]).toMatchObject({ kind: 'reconnect', attempt: 1 });
  });
});
