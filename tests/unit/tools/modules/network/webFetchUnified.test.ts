import { describe, expect, it, vi } from 'vitest';
import type {
  CanUseToolFn,
  Logger,
  ToolContext,
} from '../../../../../src/main/protocol/tools';
import { webFetchUnifiedSchema } from '../../../../../src/main/tools/modules/network/webFetchUnified.schema';
import { webFetchUnifiedModule } from '../../../../../src/main/tools/modules/network/webFetchUnified';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  };
}

describe('webFetchUnifiedModule', () => {
  it('requires action and url in the model-visible schema', () => {
    expect(webFetchUnifiedSchema.inputSchema.required).toEqual(['action', 'url']);
    expect(webFetchUnifiedSchema.description).toContain('"action": "fetch"');
  });

  it('rejects missing url before asking for network permission', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute({ action: 'request' }, makeCtx(), canUseTool);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('url');
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('rejects fetch without a prompt before asking for network permission', async () => {
    const canUseTool = vi.fn(async () => ({ allow: true })) as CanUseToolFn;
    const handler = await webFetchUnifiedModule.createHandler();

    const result = await handler.execute(
      { action: 'fetch', url: 'https://example.com' },
      makeCtx(),
      canUseTool,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
      expect(result.error).toContain('prompt');
    }
    expect(canUseTool).not.toHaveBeenCalled();
  });
});
