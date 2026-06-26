// ============================================================================
// screenshot (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { screenshotSchema } from '../../../../../src/host/plugins/builtin/computerUse/screenshot.schema';
import { screenshotModule } from '../../../../../src/host/plugins/builtin/computerUse/screenshot';

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

describe('screenshotModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata (read + plan-mode allowed)', () => {
      expect(screenshotSchema.name).toBe('screenshot');
      expect(screenshotSchema.category).toBe('vision');
      expect(screenshotSchema.permissionLevel).toBe('read');
      expect(screenshotSchema.readOnly).toBe(true);
      expect(screenshotSchema.allowInPlanMode).toBe(true);
      // screenshot has no required fields — all optional
      expect(screenshotSchema.inputSchema.required).toBeUndefined();
    });

    it('target enum restricts to screen | window', () => {
      const targetEnum =
        (screenshotSchema.inputSchema.properties as Record<string, { enum?: string[] }>).target.enum ?? [];
      expect(targetEnum).toEqual(['screen', 'window']);
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await screenshotModule.createHandler();
      const result = await handler.execute({}, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await screenshotModule.createHandler();
      const result = await handler.execute({}, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
