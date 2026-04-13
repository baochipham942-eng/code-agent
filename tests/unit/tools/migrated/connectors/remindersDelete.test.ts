// ============================================================================
// RemindersDelete (native ToolModule) Tests — P0-6.3 Batch 5
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

import { remindersDeleteModule } from '../../../../../src/main/tools/migrated/connectors/remindersDelete';

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
  const handler = await remindersDeleteModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('remindersDeleteModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(remindersDeleteModule.schema.name).toBe('reminders_delete');
      expect(remindersDeleteModule.schema.category).toBe('mcp');
      expect(remindersDeleteModule.schema.permissionLevel).toBe('write');
      expect(remindersDeleteModule.schema.readOnly).toBe(false);
      expect(remindersDeleteModule.schema.allowInPlanMode).toBe(false);
      expect(remindersDeleteModule.schema.inputSchema.required).toEqual(['list', 'reminder_id']);
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
      if (!result.ok) expect(result.error).toContain('Reminders delete failed: boom');
    });
  });

  describe('happy path', () => {
    it('deletes reminder and formats output', async () => {
      execMock.mockResolvedValue({
        data: { id: 'r1', list: 'Work', title: 'Ship PR', deleted: true },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已删除提醒：');
        expect(result.output).toContain('#r1 [Work] Ship PR');
      }
      expect(execMock).toHaveBeenCalledWith('delete_reminder', validArgs);
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: { id: 'r1', list: 'Work', title: 'x', deleted: true } });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
