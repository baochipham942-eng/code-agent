// AI SDK 适配器 per-request 超时 —— 锁住迁移时丢失、现已补回的超时契约：
//  - 非流式 generateText：requestTimeoutMs 到点 abort 本次请求 → 抛 'timeout of …' → withTransientRetry 重试。
//  - 流式 streamText：firstByteTimeoutMs（首字节前卡住→重试）+ inactivityTimeoutMs（已出 delta 后卡住→不重试，抛错）。
// 背景：旧 axios/sseStream 路径有 PROVIDER_TIMEOUT/SSE_FIRST_BYTE/SSE_INACTIVITY；AI SDK 走 fetch 无默认超时，
// 迁移漏带 → provider 卡住会一直挂到外层预算（子代理 90s 硬超时）耗尽，无 per-request 早退+重试。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { streamText, generateText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import type { StreamChunk, StreamCallback } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/host/shared/contract';

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
  return { fullStream: (async function* () { for (const p of parts) yield p; })() } as unknown as ReturnType<typeof streamText>;
}
function hangingStream(signal: AbortSignal | undefined, leadingParts: unknown[] = []) {
  return {
    fullStream: (async function* () {
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
  vi.mocked(streamText).mockReset();
  vi.mocked(generateText).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
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

  it('流式：已出 delta 后卡住到 inactivityTimeoutMs → stream inactivity timeout → 不重试，抛错', async () => {
    let calls = 0;
    vi.mocked(streamText).mockImplementation((opts: Parameters<typeof streamText>[0]) => {
      calls += 1;
      // 先吐一个 delta（emittedOutput=true），随后卡住。
      return hangingStream((opts as { abortSignal?: AbortSignal }).abortSignal, [{ type: 'text-delta', id: 't', text: 'partial' }]);
    });
    const col = makeCollector();

    const p = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream, undefined, { firstByteTimeoutMs: 9000, inactivityTimeoutMs: 1000 });
    const settled = p.then(() => 'resolved', (e) => (e instanceof Error ? e.message : String(e)));
    await vi.advanceTimersByTimeAsync(1000); // inactivity 看门狗 abort
    const outcome = await settled;

    expect(outcome).toMatch(/stream inactivity timeout/);
    expect(calls).toBe(1); // 已出 delta → 不重试
    expect(col.byType('error').length).toBe(1);
  });
});
