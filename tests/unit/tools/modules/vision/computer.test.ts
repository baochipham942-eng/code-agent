// ============================================================================
// Computer (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { computerSchema } from '../../../../../src/main/tools/modules/vision/computer.schema';
import { computerModule } from '../../../../../src/main/tools/modules/vision/computer';

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

describe('computerModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(computerSchema.name).toBe('Computer');
      expect(computerSchema.category).toBe('vision');
      expect(computerSchema.permissionLevel).toBe('execute');
      expect(computerSchema.readOnly).toBe(false);
      expect(computerSchema.allowInPlanMode).toBe(false);
      expect(computerSchema.inputSchema.required).toEqual(['action']);
    });

    it('union of screenshot + computer_use actions exposed', () => {
      const actionEnum =
        (computerSchema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
      expect(actionEnum).toContain('screenshot');
      expect(actionEnum).toContain('observe');
      expect(actionEnum).toContain('click');
      expect(actionEnum).toContain('locate_role');
      expect(actionEnum).toContain('smart_click');
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await computerModule.createHandler();
      const result = await handler.execute({ action: 'screenshot' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await computerModule.createHandler();
      const result = await handler.execute({ action: 'observe' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
