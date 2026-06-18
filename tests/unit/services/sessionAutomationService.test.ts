import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  source_session_id: string;
  type: string;
  status: string;
  title: string;
  cadence_label?: string | null;
  next_run_at?: number | null;
  last_run_at?: number | null;
  source_ref_id?: string | null;
  result_session_id?: string | null;
  config_json?: string | null;
  created_at: number;
  updated_at: number;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  messages: [] as Array<{ sessionId: string; message: unknown }>,
  taskStarts: [] as Array<{ sessionId: string; message: string; clientMessageId?: string }>,
}));

vi.mock('../../../src/main/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (!sql.includes('INSERT OR REPLACE INTO session_automations')) return;
          const [
            id,
            sourceSessionId,
            type,
            status,
            title,
            cadenceLabel,
            nextRunAt,
            lastRunAt,
            sourceRefId,
            resultSessionId,
            configJson,
            createdAt,
            updatedAt,
          ] = args;
          state.rows.set(String(id), {
            id: String(id),
            source_session_id: String(sourceSessionId),
            type: String(type),
            status: String(status),
            title: String(title),
            cadence_label: cadenceLabel as string | null,
            next_run_at: nextRunAt as number | null,
            last_run_at: lastRunAt as number | null,
            source_ref_id: sourceRefId as string | null,
            result_session_id: resultSessionId as string | null,
            config_json: configJson as string | null,
            created_at: Number(createdAt),
            updated_at: Number(updatedAt),
          });
        },
        get: (...args: unknown[]) => {
          if (sql.includes('WHERE id = ?')) {
            return state.rows.get(String(args[0]));
          }
          if (sql.includes('WHERE type = ? AND source_ref_id = ?')) {
            const [type, sourceRefId] = args;
            return [...state.rows.values()].find((row) => row.type === type && row.source_ref_id === sourceRefId);
          }
          return undefined;
        },
        all: (...args: unknown[]) => {
          if (!sql.includes('WHERE source_session_id IN')) return [];
          const ids = new Set(args.map(String));
          return [...state.rows.values()].filter((row) => ids.has(row.source_session_id));
        },
      }),
    }),
  }),
}));

vi.mock('../../../src/main/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(async (sessionId: string, message: unknown) => {
      state.messages.push({ sessionId, message });
    }),
  }),
}));

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/task', () => ({
  getTaskManager: () => ({
    getSessionState: () => ({ status: 'idle' }),
    startTask: async (
      sessionId: string,
      message: string,
      _attachments?: unknown[],
      _options?: unknown,
      _metadata?: unknown,
      clientMessageId?: string,
    ) => {
      state.taskStarts.push({ sessionId, message, clientMessageId });
    },
    interruptAndContinue: async (
      sessionId: string,
      message: string,
      _attachments?: unknown[],
      _options?: unknown,
      _metadata?: unknown,
      clientMessageId?: string,
    ) => {
      state.taskStarts.push({ sessionId, message, clientMessageId });
    },
  }),
}));

import { SessionAutomationService } from '../../../src/main/services/sessionAutomation/sessionAutomationService';

describe('SessionAutomationService', () => {
  beforeEach(() => {
    state.rows.clear();
    state.messages = [];
    state.taskStarts = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T02:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records creation as a durable automation plus renderable meta message', async () => {
    const service = new SessionAutomationService();

    const record = await service.recordCreated({
      id: 'cron:job-1',
      sourceSessionId: 'session-1',
      type: 'cron',
      status: 'active',
      title: '主题页编排巡检',
      cadenceLabel: '每 15 分钟',
      nextRunAt: Date.now() + 15 * 60_000,
      sourceRefId: 'job-1',
    });

    expect(record.id).toBe('cron:job-1');
    expect(state.rows.get('cron:job-1')?.source_session_id).toBe('session-1');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      sessionId: 'session-1',
      message: {
        id: 'automation:created:cron:job-1',
        isMeta: true,
        source: 'automation',
        metadata: {
          automation: {
            automationId: 'cron:job-1',
            automationType: 'cron',
            event: 'created',
            sourceSessionId: 'session-1',
          },
        },
      },
    });
  });

  it('summarizes the next active automation for sidebar badges', () => {
    const service = new SessionAutomationService();
    service.upsert({
      id: 'cron:job-1',
      sourceSessionId: 'session-1',
      type: 'cron',
      status: 'active',
      title: '巡检',
      cadenceLabel: '每 15 分钟',
      nextRunAt: Date.now() + 5 * 60_000,
      sourceRefId: 'job-1',
    });

    const summary = service.summarizeSessions(['session-1'])['session-1'];

    expect(summary.activeCount).toBe(1);
    expect(summary.label).toBe('5 分');
    expect(summary.tooltip).toContain('巡检');
  });

  it('can write a completed event while keeping a recurring automation active', async () => {
    const service = new SessionAutomationService();
    service.upsert({
      id: 'cron:job-1',
      sourceSessionId: 'session-1',
      type: 'cron',
      status: 'active',
      title: '巡检',
      cadenceLabel: '每 15 分钟',
      nextRunAt: Date.now() + 15 * 60_000,
      sourceRefId: 'job-1',
    });

    await service.recordEvent({
      type: 'cron',
      sourceRefId: 'job-1',
      event: 'completed',
      status: 'completed',
      recordStatus: 'active',
      resultSessionId: 'result-session-1',
      eventId: 'execution:exec-1',
      summary: '定时任务已完成。',
    });

    expect(state.rows.get('cron:job-1')?.status).toBe('active');
    expect(state.rows.get('cron:job-1')?.result_session_id).toBe('result-session-1');
    expect(state.messages.at(-1)).toMatchObject({
      message: {
        id: 'automation:execution:exec-1',
        content: expect.stringContaining('自动化已完成'),
      },
    });
    expect(state.taskStarts).toHaveLength(0);
  });

  it('sends the configured handoff prompt into the source session after completion', async () => {
    const service = new SessionAutomationService();
    service.upsert({
      id: 'cron:job-1',
      sourceSessionId: 'session-1',
      type: 'cron',
      status: 'active',
      title: '巡检',
      sourceRefId: 'job-1',
      config: {
        handoffPrompt: '读取结果会话，继续下一阶段判断。',
        nextStage: { title: '继续判断', prompt: '读取结果会话，继续下一阶段判断。' },
      },
    });

    await service.recordEvent({
      type: 'cron',
      sourceRefId: 'job-1',
      event: 'completed',
      status: 'completed',
      recordStatus: 'completed',
      resultSessionId: 'result-session-1',
      eventId: 'execution:exec-1',
      summary: '定时任务已完成。',
    });
    await vi.waitFor(() => {
      expect(state.taskStarts).toHaveLength(1);
    });

    expect(state.messages.at(-1)).toMatchObject({
      message: {
        content: expect.stringContaining('已发送交接提示词'),
      },
    });
    expect(state.taskStarts).toMatchObject([
      {
        sessionId: 'session-1',
        message: '读取结果会话，继续下一阶段判断。',
      },
    ]);
  });
});
