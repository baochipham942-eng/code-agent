// ============================================================================
// Browser (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import { browserSchema } from '../../../../../src/host/plugins/builtin/browserControl/browser.schema';
import { browserModule } from '../../../../../src/host/plugins/builtin/browserControl/browser';

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

describe('browserModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(browserSchema.name).toBe('Browser');
      expect(browserSchema.category).toBe('vision');
      expect(browserSchema.permissionLevel).toBe('execute');
      expect(browserSchema.readOnly).toBe(false);
      expect(browserSchema.allowInPlanMode).toBe(false);
      expect(browserSchema.inputSchema.required).toEqual(['action']);
    });

    it('exposes both OS-level and Playwright actions in enum', () => {
      const actionEnum =
        (browserSchema.inputSchema.properties as Record<string, { enum?: string[] }>).action.enum ?? [];
      expect(actionEnum).toContain('open');
      expect(actionEnum).toContain('launch');
      expect(actionEnum).toContain('screenshot');
      expect(actionEnum).toContain('switchTab');
      expect(actionEnum).toContain('switch_tab');
      expect(actionEnum).toContain('upload_file');
      expect(actionEnum).toContain('wait_for_download');
      expect(browserSchema.inputSchema.properties).toMatchObject({
        uploadFilePath: { type: 'string' },
        engine: { enum: ['auto', 'managed', 'relay'] },
        relayDomainScopes: { type: 'array' },
        relayActionScopes: { type: 'array' },
      });
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await browserModule.createHandler();
      const result = await handler.execute({ action: 'launch' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await browserModule.createHandler();
      const result = await handler.execute({ action: 'launch' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
