// ============================================================================
// Ingress Pipeline Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IngressPipeline, type IngressMessage } from '../../../src/main/channels/ingressPipeline';

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('IngressPipeline', () => {
  let processedMessages: IngressMessage[];
  let processMessage: (msg: IngressMessage) => Promise<void>;
  let pipeline: IngressPipeline;

  beforeEach(() => {
    vi.useFakeTimers();
    processedMessages = [];
    processMessage = vi.fn(async (msg: IngressMessage) => {
      processedMessages.push(msg);
    });
  });

  afterEach(() => {
    pipeline?.shutdown();
    vi.useRealTimers();
  });

  it('should debounce messages within debounceMs', async () => {
    pipeline = new IngressPipeline({
      debounceMs: 100,
      processMessage,
    });

    pipeline.enqueue({ sessionKey: 'user:1', content: 'hello', timestamp: 1 });
    pipeline.enqueue({ sessionKey: 'user:1', content: 'world', timestamp: 2 });

    // Not yet processed (debounce timer active)
    expect(processedMessages).toHaveLength(0);

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(150);

    // Should be merged into one message
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processedMessages[0]!.content).toBe('hello\nworld');
  });

  it('should process messages from different sessions independently', async () => {
    pipeline = new IngressPipeline({
      debounceMs: 50,
      processMessage,
    });

    pipeline.enqueue({ sessionKey: 'user:1', content: 'msg1', timestamp: 1 });
    pipeline.enqueue({ sessionKey: 'user:2', content: 'msg2', timestamp: 2 });

    await vi.advanceTimersByTimeAsync(100);

    // Both should be processed separately
    expect(processMessage).toHaveBeenCalledTimes(2);
    const keys = processedMessages.map(m => m.sessionKey);
    expect(keys).toContain('user:1');
    expect(keys).toContain('user:2');
  });

  it('should enforce session lock (same session serialized)', async () => {
    const processingOrder: string[] = [];
    let resolveFirst: (() => void) | null = null;

    const slowProcess = vi.fn(async (msg: IngressMessage) => {
      processingOrder.push(`start:${msg.content}`);
      if (msg.content === 'first') {
        await new Promise<void>(resolve => { resolveFirst = resolve; });
      }
      processingOrder.push(`end:${msg.content}`);
    });

    pipeline = new IngressPipeline({
      debounceMs: 10,
      processMessage: slowProcess,
    });

    // Send first message
    pipeline.enqueue({ sessionKey: 'user:1', content: 'first', timestamp: 1 });
    await vi.advanceTimersByTimeAsync(20);

    // First should be processing
    expect(processingOrder).toContain('start:first');

    // Send second message to same session
    pipeline.enqueue({ sessionKey: 'user:1', content: 'second', timestamp: 2 });
    await vi.advanceTimersByTimeAsync(20);

    // Second should be queued (not started) because session is locked
    expect(processingOrder).not.toContain('start:second');

    // Complete first
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Now second should process
    expect(processingOrder).toContain('start:second');
  });

  it('should drop oldest when queue overflows', async () => {
    let blockResolve: (() => void) | null = null;

    const blockingProcess = vi.fn(async (msg: IngressMessage) => {
      processedMessages.push(msg);
      // Block indefinitely to fill the queue
      await new Promise<void>(resolve => { blockResolve = resolve; });
    });

    pipeline = new IngressPipeline({
      debounceMs: 10,
      maxQueueSize: 3,
      processMessage: blockingProcess,
    });

    // Fill the queue: first message gets processed, rest queue up
    pipeline.enqueue({ sessionKey: 's1', content: 'active', timestamp: 1 });
    await vi.advanceTimersByTimeAsync(20);

    // Queue up messages for same session (will be blocked by lock)
    for (let i = 0; i < 5; i++) {
      pipeline.enqueue({ sessionKey: 's1', content: `msg${i}`, timestamp: i + 10 });
      await vi.advanceTimersByTimeAsync(20);
    }

    // Queue should not exceed maxQueueSize
    const stats = pipeline.getStats();
    expect(stats.queueDepth).toBeLessThanOrEqual(3);
  });

  it('should report stats correctly', async () => {
    pipeline = new IngressPipeline({
      debounceMs: 100,
      processMessage,
    });

    const stats1 = pipeline.getStats();
    expect(stats1.queueDepth).toBe(0);
    expect(stats1.activeSession).toBe(0);
    expect(stats1.debouncing).toBe(0);

    pipeline.enqueue({ sessionKey: 'user:1', content: 'test', timestamp: 1 });

    const stats2 = pipeline.getStats();
    expect(stats2.debouncing).toBe(1);
  });

  it('should cleanup on shutdown', async () => {
    pipeline = new IngressPipeline({
      debounceMs: 1000,
      processMessage,
    });

    pipeline.enqueue({ sessionKey: 'user:1', content: 'test', timestamp: 1 });

    pipeline.shutdown();

    const stats = pipeline.getStats();
    expect(stats.queueDepth).toBe(0);
    expect(stats.activeSession).toBe(0);
    expect(stats.debouncing).toBe(0);
  });

  it('should handle processMessage errors gracefully', async () => {
    const failingProcess = vi.fn(async () => {
      throw new Error('process failed');
    });

    pipeline = new IngressPipeline({
      debounceMs: 10,
      processMessage: failingProcess,
    });

    pipeline.enqueue({ sessionKey: 'user:1', content: 'test', timestamp: 1 });
    await vi.advanceTimersByTimeAsync(20);

    // Should not throw, just log
    expect(failingProcess).toHaveBeenCalled();

    // Pipeline should still be functional
    const stats = pipeline.getStats();
    expect(stats.activeSession).toBe(0);
  });
});
