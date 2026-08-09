import { describe, expect, it, vi } from 'vitest';
import { recordMessageProcessorModelCallTelemetry } from '../../../src/host/agent/runtime/messageProcessorTelemetry';

describe('recordMessageProcessorModelCallTelemetry', () => {
  it('forwards provider prompt-cache usage to telemetry', () => {
    const onModelCall = vi.fn();
    const ctx = {
      telemetryAdapter: { onModelCall },
      turn: { currentTurnId: 'turn-cache' },
      messages: [],
      modelConfig: { provider: 'anthropic', model: 'claude-test', temperature: 0, maxTokens: 1024 },
      stats: {},
    };

    recordMessageProcessorModelCallTelemetry(ctx as never, {
      type: 'text',
      content: 'done',
      usage: {
        inputTokens: 120,
        outputTokens: 24,
        cacheReadTokens: 4096,
        cacheCreationTokens: 512,
      },
    } as never, 1, 10);

    expect(onModelCall).toHaveBeenCalledWith('turn-cache', expect.objectContaining({
      cacheReadTokens: 4096,
      cacheCreationTokens: 512,
    }));
  });
});
