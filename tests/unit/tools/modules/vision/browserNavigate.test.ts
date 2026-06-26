// ============================================================================
// browser_navigate (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { browserNavigateSchema } from '../../../../../src/host/plugins/builtin/browserControl/browserNavigate.schema';
import { browserNavigateModule } from '../../../../../src/host/plugins/builtin/browserControl/browserNavigate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

describe('browserNavigateModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(browserNavigateSchema.name).toBe('browser_navigate');
      expect(browserNavigateSchema.category).toBe('vision');
      expect(browserNavigateSchema.permissionLevel).toBe('execute');
      expect(browserNavigateSchema.readOnly).toBe(false);
      expect(browserNavigateSchema.allowInPlanMode).toBe(false);
      expect(browserNavigateSchema.inputSchema.required).toEqual(['action']);
    });

    it('exposes OS-level navigate action enum', () => {
      const actionEnum =
        (browserNavigateSchema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
      expect(actionEnum).toEqual([
        'open', 'navigate', 'back', 'forward', 'refresh', 'close', 'newTab', 'switchTab',
      ]);
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await browserNavigateModule.createHandler();
      const result = await handler.execute({ action: 'open', url: 'https://example.com' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await browserNavigateModule.createHandler();
      const result = await handler.execute({ action: 'open' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
