// ============================================================================
// Calendar (native ToolModule) Tests — P0-6.3 Batch 6
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

import { calendarModule } from '../../../../../src/main/tools/modules/connectors/calendar';

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

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await calendarModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('calendarModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(calendarModule.schema.name).toBe('calendar');
      expect(calendarModule.schema.category).toBe('mcp');
      expect(calendarModule.schema.permissionLevel).toBe('read');
      expect(calendarModule.schema.readOnly).toBe(true);
      expect(calendarModule.schema.allowInPlanMode).toBe(true);
      expect(calendarModule.schema.inputSchema.required).toEqual(['action']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'wipe_everything' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'get_status' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ action: 'get_status' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when connector missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('wraps connector errors', async () => {
      execMock.mockRejectedValue(new Error('boom'));
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Calendar connector failed: boom');
    });
  });

  describe('actions happy path', () => {
    it('get_status formats connected status', async () => {
      execMock.mockResolvedValue({
        data: { connected: true, detail: 'EventKit OK', capabilities: ['read', 'write'] },
      });
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Calendar connector: connected');
        expect(result.output).toContain('EventKit OK');
        expect(result.output).toContain('Capabilities: read, write');
      }
    });

    it('list_calendars formats calendar names', async () => {
      execMock.mockResolvedValue({ data: ['Home', 'Work', 'Birthdays'] });
      const result = await run({ action: 'list_calendars' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('可用日历 (3)');
        expect(result.output).toContain('- Home');
        expect(result.output).toContain('- Work');
        expect(result.output).toContain('- Birthdays');
      }
    });

    it('list_calendars empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_calendars' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到可访问的日历。');
    });

    it('list_events formats events with uid and location', async () => {
      execMock.mockResolvedValue({
        data: [
          {
            calendar: 'Work',
            title: 'Standup',
            startAtMs: 1700000000000,
            endAtMs: 1700001800000,
            location: 'Zoom',
            uid: 'evt-1',
          },
          {
            calendar: 'Home',
            title: 'Dinner',
            startAtMs: 1700100000000,
            endAtMs: 1700103600000,
          },
        ],
      });
      const result = await run({ action: 'list_events' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('日历事件 (2)');
        expect(result.output).toContain('[Work] Standup');
        expect(result.output).toContain('| Zoom');
        expect(result.output).toContain('uid: evt-1');
        expect(result.output).toContain('[Home] Dinner');
      }
    });

    it('list_events empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_events' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到匹配的日历事件。');
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: [] });
      const onProgress = vi.fn();
      await run({ action: 'list_calendars' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
