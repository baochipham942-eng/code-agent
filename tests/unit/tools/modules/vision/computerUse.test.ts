// ============================================================================
// computer_use (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { computerUseSchema } from '../../../../../src/host/plugins/builtin/computerUse/computerUse.schema';
import { computerUseModule } from '../../../../../src/host/plugins/builtin/computerUse/computerUse';

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

describe('computerUseModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(computerUseSchema.name).toBe('computer_use');
      expect(computerUseSchema.category).toBe('vision');
      expect(computerUseSchema.permissionLevel).toBe('execute');
      expect(computerUseSchema.readOnly).toBe(false);
      expect(computerUseSchema.allowInPlanMode).toBe(false);
      expect(computerUseSchema.inputSchema.required).toEqual(['action']);
    });

    it('exposes basic + smart actions', () => {
      const actionEnum =
        (computerUseSchema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
      expect(actionEnum).toContain('get_state');
      expect(actionEnum).toContain('click');
      expect(actionEnum).toContain('type');
      expect(actionEnum).toContain('locate_role');
      expect(actionEnum).toContain('smart_click');
      expect(actionEnum).toContain('get_ax_elements');
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await computerUseModule.createHandler();
      const result = await handler.execute({ action: 'observe' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await computerUseModule.createHandler();
      const result = await handler.execute({ action: 'get_state' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
