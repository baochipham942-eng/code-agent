// ============================================================================
// gui_agent (vision Level 1 wrapper) Tests
// schema 字段 + permission deny + abort，不执行 legacy 实现
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import { guiAgentSchema } from '../../../../../src/main/plugins/builtin/computerUse/guiAgent.schema';
import { guiAgentModule } from '../../../../../src/main/plugins/builtin/computerUse/guiAgent';

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

describe('guiAgentModule (vision Level 1)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(guiAgentSchema.name).toBe('gui_agent');
      expect(guiAgentSchema.category).toBe('vision');
      expect(guiAgentSchema.permissionLevel).toBe('execute');
      expect(guiAgentSchema.readOnly).toBe(false);
      expect(guiAgentSchema.allowInPlanMode).toBe(false);
      expect(guiAgentSchema.inputSchema.required).toEqual(['task']);
    });

    it('lists task / model / max_steps / timeout_ms params', () => {
      const props = guiAgentSchema.inputSchema.properties as Record<string, { type: string }>;
      expect(props.task.type).toBe('string');
      expect(props.model.type).toBe('string');
      expect(props.max_steps.type).toBe('number');
      expect(props.timeout_ms.type).toBe('number');
    });
  });

  describe('execute gating', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: false, reason: 'no-perm' });
      const handler = await guiAgentModule.createHandler();
      const result = await handler.execute({ task: 'open Calculator' }, makeCtx(), canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal already aborted', async () => {
      const canUseTool: CanUseToolFn = async () => ({ allow: true });
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const handler = await guiAgentModule.createHandler();
      const result = await handler.execute({ task: 'noop' }, ctx, canUseTool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });
});
