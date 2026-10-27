import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import { inferenceViaAiSdk } from '../../../src/host/model/adapters/aiSdkAdapter';
import { QuotaWaitSuspendError } from '../../../src/host/model/providers/retryStrategy';
import type { StreamCallback, StreamChunk } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract';

const health = vi.hoisted(() => ({ recordFailure: vi.fn(), recordSuccess: vi.fn() }));

vi.mock('../../../src/host/model/providers/providerResolution', () => ({
  resolveProviderBaseUrl: () => 'https://test.local/v1',
  resolveProviderApiKey: () => 'test-key',
}));
vi.mock('../../../src/host/model/providerHealthMonitor', () => ({
  getProviderHealthMonitor: () => health,
}));
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, streamText: vi.fn(), generateText: vi.fn() };
});

const CONFIG = { provider: 'xiaomi', model: 'mimo-v2.5-pro', temperature: 0.7 } as ModelConfig;

function streamOf(parts: unknown[]) {
  return { stream: (async function* () { for (const part of parts) yield part; })() } as unknown as ReturnType<typeof streamText>;
}

function makeCollector() {
  const chunks: StreamChunk[] = [];
  const onStream: StreamCallback = (chunk) => { if (typeof chunk !== 'string') chunks.push(chunk); };
  return { onStream, chunks, byType: (type: StreamChunk['type']) => chunks.filter((chunk) => chunk.type === type) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.mocked(streamText).mockReset();
  health.recordFailure.mockReset();
  health.recordSuccess.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('inferenceViaAiSdk quota wait', () => {
  it('suspends a first-byte 429 with Retry-After 75s and does not sleep or emit an error chunk', async () => {
    const err = Object.assign(new Error('limited'), { statusCode: 429, responseHeaders: { 'retry-after': '75' } });
    vi.mocked(streamText).mockImplementation(() => { throw err; });
    const col = makeCollector();
    const pending = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream);
    const outcome = await Promise.race([
      pending.then(() => 'resolved' as const, (error: unknown) => error),
      vi.advanceTimersByTimeAsync(5_000).then(() => 'slept' as const),
    ]);
    expect(outcome).toBeInstanceOf(QuotaWaitSuspendError);
    expect((outcome as QuotaWaitSuspendError).waitMs).toBe(75_000);
    expect(col.byType('error')).toHaveLength(0);
    expect(health.recordFailure).not.toHaveBeenCalled();
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
  });

  it('keeps a mid-stream 75s retry-after on the capped reconnect path', async () => {
    const err = Object.assign(new Error('limited'), { status: 429, headers: { 'retry-after': '75' } });
    vi.mocked(streamText)
      .mockReturnValueOnce(streamOf([
        { type: 'text-delta', id: 't', text: 'partial' },
        { type: 'error', error: err },
      ]))
      .mockReturnValueOnce(streamOf([
        { type: 'text-delta', id: 't', text: 'done' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]));
    const col = makeCollector();
    const pending = inferenceViaAiSdk([{ role: 'user', content: 'hi' }], [], CONFIG, col.onStream);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result.content).toBe('done');
    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(2);
    expect(col.byType('error')).toHaveLength(0);
  });
});
