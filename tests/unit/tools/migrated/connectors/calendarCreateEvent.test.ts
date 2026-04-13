// ============================================================================
// CalendarCreateEvent (native ToolModule) Tests — P0-6.3 Batch 6
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

import { calendarCreateEventModule } from '../../../../../src/main/tools/migrated/connectors/calendarCreateEvent';

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

const validArgs = { calendar: 'Work', title: 'Standup', start_ms: 1700000000000 };

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await calendarCreateEventModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('calendarCreateEventModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(calendarCreateEventModule.schema.name).toBe('calendar_create_event');
      expect(calendarCreateEventModule.schema.category).toBe('mcp');
      expect(calendarCreateEventModule.schema.permissionLevel).toBe('write');
      expect(calendarCreateEventModule.schema.readOnly).toBe(false);
      expect(calendarCreateEventModule.schema.allowInPlanMode).toBe(false);
      expect(calendarCreateEventModule.schema.inputSchema.required).toEqual([
        'calendar',
        'title',
        'start_ms',
      ]);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing calendar', async () => {
      const result = await run({ title: 'x', start_ms: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing title', async () => {
      const result = await run({ calendar: 'Work', start_ms: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing start_ms', async () => {
      const result = await run({ calendar: 'Work', title: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty calendar string', async () => {
      const result = await run({ calendar: '', title: 'x', start_ms: 1 });
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
      if (!result.ok) expect(result.error).toContain('Calendar create failed: boom');
    });
  });

  describe('happy path', () => {
    it('creates event and formats output', async () => {
      execMock.mockResolvedValue({
        data: {
          calendar: 'Work',
          title: 'Standup',
          startAtMs: 1700000000000,
          endAtMs: 1700001800000,
          location: 'Zoom',
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已创建日历事件：');
        expect(result.output).toContain('- [Work] Standup');
        expect(result.output).toContain('- 开始：');
        expect(result.output).toContain('- 地点：Zoom');
      }
      expect(execMock).toHaveBeenCalledWith('create_event', validArgs);
    });

    it('emits starting progress', async () => {
      execMock.mockResolvedValue({
        data: { calendar: 'Work', title: 'x', startAtMs: 1, endAtMs: 2 },
      });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
