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

type ParkedRow = { id: string; kind: string; status: string; payloadJson: string; submittedAt: number; coordinatorId: string | null };

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  parkedRows: new Map<string, ParkedRow>(),
  messages: [] as Array<{ sessionId: string; message: unknown }>,
  taskStarts: [] as Array<{ sessionId: string; message: string; clientMessageId?: string }>,
  broadcasts: [] as Array<{ channel: string; data: unknown }>,
  sessionStatus: 'idle' as string,
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: (channel: string, data: unknown) => {
    state.broadcasts.push({ channel, data });
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
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
    getPendingApprovalRepo: () => ({
      listByKindAndStatus: (kind: string, status: string) =>
        [...state.parkedRows.values()]
          .filter((row) => row.kind === kind && row.status === status)
          .map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            payloadJson: row.payloadJson,
            submittedAt: row.submittedAt,
            coordinatorId: row.coordinatorId,
            agentId: null,
            agentName: null,
            resolvedAt: null,
            feedback: null,
          })),
    }),
  }),
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: vi.fn(async (sessionId: string, message: unknown) => {
      state.messages.push({ sessionId, message });
    }),
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/task', () => ({
  getTaskManager: () => ({
    getSessionState: () => ({ status: state.sessionStatus }),
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

import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

describe('SessionAutomationService', () => {
  beforeEach(() => {
    state.rows.clear();
    state.parkedRows.clear();
    state.messages = [];
    state.taskStarts = [];
    state.broadcasts = [];
    state.sessionStatus = 'idle';
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

  it('does NOT trigger the handoff on a recurring tick that keeps the automation active', async () => {
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

    // recurring cron 每个 tick 都发 event='completed'，但 recordStatus 保持 active。
    // 即便配了 handoffPrompt，也绝不能每轮自动接一棒（否则无限烧钱）。
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

    // 给异步的 runConfiguredNextStep 一个可能执行的机会，确认它确实没被触发。
    await Promise.resolve();
    expect(state.rows.get('cron:job-1')?.status).toBe('active');
    expect(state.taskStarts).toHaveLength(0);
    // 也不应在回流消息里宣称「已发送交接提示词」。
    expect(state.messages.at(-1)).not.toMatchObject({
      message: { content: expect.stringContaining('已发送交接提示词') },
    });
  });

  it('defers the handoff to a visible message instead of interrupting a busy session', async () => {
    state.sessionStatus = 'running';
    const service = new SessionAutomationService();
    service.upsert({
      id: 'loop:run-1',
      sourceSessionId: 'session-1',
      type: 'loop',
      status: 'running',
      title: '循环任务',
      sourceRefId: 'run-1',
      config: {
        handoffPrompt: '循环结束，汇总本轮结论。',
        nextStage: { title: '循环完成后继续', prompt: '循环结束，汇总本轮结论。' },
      },
    });

    await service.recordEvent({
      automationId: 'loop:run-1',
      event: 'completed',
      status: 'completed',
      recordStatus: 'completed',
      eventId: 'loop-finalized',
      summary: '循环已完成。',
    });

    await vi.waitFor(() => {
      expect(
        state.messages.some((entry) =>
          typeof (entry.message as { content?: string }).content === 'string' &&
          (entry.message as { content: string }).content.includes('当前会话正忙'),
        ),
      ).toBe(true);
    });
    // 忙会话绝不打断：不调用 startTask / interruptAndContinue。
    expect(state.taskStarts).toHaveLength(0);
  });

  it('broadcasts every automation message to the renderer for live visibility', async () => {
    const service = new SessionAutomationService();
    await service.recordCreated({
      id: 'cron:job-1',
      sourceSessionId: 'session-1',
      type: 'cron',
      status: 'active',
      title: '巡检',
      sourceRefId: 'job-1',
    });

    const created = state.broadcasts.find(
      (b) => b.channel === 'sessionAutomation:message',
    );
    expect(created).toBeDefined();
    expect(created?.data).toMatchObject({
      sessionId: 'session-1',
      message: { id: 'automation:created:cron:job-1', isMeta: true },
    });
  });

  describe('listParkedApprovals (B2)', () => {
    it('id 原样返回（= requestId），拿去 permissionResponse 能命中内存 pending', () => {
      // 停车行 id = parkApproval 写入时的 requestId；listParkedApprovals 不得改写 id，
      // 否则收件箱回传 permissionResponse 会命中不了内存 pending。
      state.parkedRows.set('perm_req_abc', {
        id: 'perm_req_abc',
        kind: 'tool_approval',
        status: 'pending',
        submittedAt: 1000,
        coordinatorId: 'session-xyz',
        payloadJson: JSON.stringify({ sessionId: 'session-xyz', tool: 'mail_send', requestedAt: 1000, riskClass: 'external' }),
      });

      const items = new SessionAutomationService().listParkedApprovals();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('perm_req_abc'); // 恒等，回传 permissionResponse 的 requestId
      expect(items[0].sessionId).toBe('session-xyz');
      expect(items[0].tool).toBe('mail_send');
      expect(items[0].riskClass).toBe('external');
      expect(items[0].status).toBe('pending');
    });

    it('orphaned 行进列表但标灰态（不可操作）', () => {
      state.parkedRows.set('perm_orph', {
        id: 'perm_orph',
        kind: 'tool_approval',
        status: 'orphaned',
        submittedAt: 500,
        coordinatorId: 'session-1',
        payloadJson: JSON.stringify({ sessionId: 'session-1', tool: 'bash', requestedAt: 500 }),
      });
      const items = new SessionAutomationService().listParkedApprovals();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('orphaned');
    });
  });
});
