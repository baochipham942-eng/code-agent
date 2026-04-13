// ============================================================================
// RemindersUpdate (native ToolModule) Tests — P0-6.3 Batch 5
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../../../src/main/connectors', () => ({
  getConnectorRegistry: () => ({
    get: getMock,
  }),
}));

import { remindersUpdateModule } from '../../../../../src/main/tools/modules/connectors/remindersUpdate';

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

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

const validArgs = { list: 'Work', reminder_id: 'r1' };

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await remindersUpdateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('remindersUpdateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(remindersUpdateModule.schema.name).toBe('reminders_update');
      expect(remindersUpdateModule.schema.category).toBe('mcp');
      expect(remindersUpdateModule.schema.permissionLevel).toBe('write');
      expect(remindersUpdateModule.schema.readOnly).toBe(false);
      expect(remindersUpdateModule.schema.allowInPlanMode).toBe(false);
      expect(remindersUpdateModule.schema.inputSchema.required).toEqual(['list', 'reminder_id']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing list', async () => {
      const result = await run({ reminder_id: 'r1' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing reminder_id', async () => {
      const result = await run({ list: 'Work' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(validArgs, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run(validArgs, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when connector missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('wraps connector errors', async () => {
      execMock.mockRejectedValue(new Error('boom'));
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Reminders update failed: boom');
    });
  });

  describe('happy path', () => {
    it('updates reminder and formats output (open)', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r1', list: 'Work', title: 'Ship PR', completed: false },
      });
      const result = await run({ ...validArgs, title: 'Ship PR' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已更新提醒：');
        expect(result.output).toContain('#r1 [Work] Ship PR');
        expect(result.output).not.toContain('(completed)');
      }
      expect(execMock).toHaveBeenCalledWith('update_reminder', expect.objectContaining({ list: 'Work', reminder_id: 'r1' }));
    });

    it('updates reminder and formats output (completed)', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r1', list: 'Work', title: 'Ship PR', completed: true },
      });
      const result = await run({ ...validArgs, completed: true });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('#r1 [Work] Ship PR (completed)');
      }
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: { id: 'r1', list: 'Work', title: 'x', completed: false } });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
