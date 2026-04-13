// ============================================================================
// CalendarDeleteEvent (native ToolModule) Tests — P0-6.3 Batch 6
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

import { calendarDeleteEventModule } from '../../../../../src/main/tools/migrated/connectors/calendarDeleteEvent';

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

const validArgs = { calendar: 'Work', event_uid: 'evt-1' };

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await calendarDeleteEventModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('calendarDeleteEventModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(calendarDeleteEventModule.schema.name).toBe('calendar_delete_event');
      expect(calendarDeleteEventModule.schema.category).toBe('mcp');
      expect(calendarDeleteEventModule.schema.permissionLevel).toBe('write');
      expect(calendarDeleteEventModule.schema.readOnly).toBe(false);
      expect(calendarDeleteEventModule.schema.allowInPlanMode).toBe(false);
      expect(calendarDeleteEventModule.schema.inputSchema.required).toEqual([
        'calendar',
        'event_uid',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing calendar', async () => {
      const result = await run({ event_uid: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing event_uid', async () => {
      const result = await run({ calendar: 'Work' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty calendar string', async () => {
      const result = await run({ calendar: '', event_uid: 'x' });
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
      if (!result.ok) expect(result.error).toContain('Calendar delete failed: boom');
    });
  });

  describe('happy path', () => {
    it('deletes event and formats output', async () => {
      execMock.mockResolvedValue({
        data: {
          uid: 'evt-1',
          calendar: 'Work',
          title: 'Standup',
          deleted: true,
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已删除日历事件：');
        expect(result.output).toContain('- [Work] Standup');
        expect(result.output).toContain('- uid: evt-1');
      }
      expect(execMock).toHaveBeenCalledWith('delete_event', validArgs);
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({
        data: { uid: 'evt-1', calendar: 'Work', title: 'x', deleted: true },
      });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
