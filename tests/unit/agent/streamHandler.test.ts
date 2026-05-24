import { describe, expect, it, vi } from 'vitest';
import { StreamHandler } from '../../../src/main/agent/runtime/streamHandler';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('StreamHandler', () => {
  it('accumulates input and output token counters for runtime accounting', () => {
    const ctx = {
      modelConfig: { provider: 'test-provider', model: 'test-model' },
      onEvent: vi.fn(),
      totalTokensUsed: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    const handler = new StreamHandler(ctx as any, {} as any, {} as any);

    handler.emitModelResponse({
      type: 'text',
      content: 'done',
      usage: { inputTokens: 120, outputTokens: 7 },
    } as any, 42);

    expect(ctx.totalInputTokens).toBe(120);
    expect(ctx.totalOutputTokens).toBe(7);
    expect(ctx.totalTokensUsed).toBe(127);
    expect(ctx.onEvent).toHaveBeenCalledWith({
      type: 'model_response',
      data: expect.objectContaining({
        inputTokens: 120,
        outputTokens: 7,
      }),
    });
  });
});
