// ============================================================================
// browser_action (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { browserActionSchema } from '../../../../../src/main/plugins/builtin/browserControl/browserAction.schema';
import { browserActionModule } from '../../../../../src/main/plugins/builtin/browserControl/browserAction';

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

describe('browserActionModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(browserActionSchema.name).toBe('browser_action');
      expect(browserActionSchema.category).toBe('vision');
      expect(browserActionSchema.permissionLevel).toBe('execute');
      expect(browserActionSchema.readOnly).toBe(false);
      expect(browserActionSchema.allowInPlanMode).toBe(false);
      expect(browserActionSchema.inputSchema.required).toEqual(['action']);
    });

    it('exposes Playwright + workbench/storage actions', () => {
      const actionEnum =
        (browserActionSchema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
      expect(actionEnum).toContain('launch');
      expect(actionEnum).toContain('get_dom_snapshot');
      expect(actionEnum).toContain('export_storage_state');
      expect(actionEnum).toContain('upload_file');
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await browserActionModule.createHandler();
      const result = await handler.execute({ action: 'launch' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await browserActionModule.createHandler();
      const result = await handler.execute({ action: 'launch' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
