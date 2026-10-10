// A4 待过目：markReviewed / countPendingReviewByTask / summarizeSessions.pendingReviewCount
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  // countPendingReviewByTask 用同步 getSession 解析运行会话的 origin（只取 origin）。
  sessions: new Map<string, { origin?: { kind?: string; id?: string } } | null>(),
}));

vi.mock('../../../src/host/platform', () => ({
  broadcastToRenderer: () => undefined,
}));

vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({ addMessageToSession: async () => undefined }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (sql.includes('INSERT OR REPLACE INTO session_automations')) {
            const [id, sourceSessionId, type, status, title, cadenceLabel, nextRunAt, lastRunAt, sourceRefId, resultSessionId, configJson, createdAt, updatedAt] = args;
            state.rows.set(String(id), {
              id, source_session_id: sourceSessionId, type, status, title,
              cadence_label: cadenceLabel, next_run_at: nextRunAt, last_run_at: lastRunAt,
              source_ref_id: sourceRefId, result_session_id: resultSessionId,
              config_json: configJson, created_at: createdAt, updated_at: updatedAt,
            });
            return;
          }
          if (sql.startsWith('UPDATE session_automations SET status')) {
            const [status, configJson, updatedAt, id] = args;
            const row = state.rows.get(String(id));
            if (row) {
              row.status = status;
              row.config_json = configJson;
              row.updated_at = updatedAt;
            }
          }
        },
        get: (id: unknown) => state.rows.get(String(id)),
        all: (...ids: unknown[]) => {
          const rows = [...state.rows.values()];
          if (sql.includes('WHERE source_session_id IN')) {
            return rows.filter((row) => ids.map(String).includes(String(row.source_session_id)));
          }
          return rows;
        },
      }),
    }),
    getSession: (id: string) => state.sessions.get(String(id)) ?? null,
  }),
}));

import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

function seed(service: SessionAutomationService, id: string, over: Record<string, unknown> = {}) {
  service.upsert({
    id,
    sourceSessionId: 'src-1',
    type: 'cron',
    status: 'active',
    title: id,
    sourceRefId: id,
    ...over,
  } as never);
}

beforeEach(() => {
  state.rows.clear();
  state.sessions.clear();
});

describe('pending review', () => {
  it('countPendingReviewByTask 同时统计 status=pending_review 与 config.pendingReview 标记（无任务可折时按记录计）', () => {
    const service = new SessionAutomationService();
    seed(service, 'a1', { status: 'pending_review' });
    seed(service, 'a2', { status: 'active', config: { pendingReview: { resultSessionId: 'r2', at: 1 } } });
    seed(service, 'a3', { status: 'active' });
    expect(service.countPendingReviewByTask()).toBe(2);
    expect(service.listPendingReview().map((r) => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('countPendingReviewByTask 同一任务的 3 条待过目只计 1（任务口径，不按运行会话重复计）', () => {
    const service = new SessionAutomationService();
    seed(service, 'a1', { status: 'pending_review', resultSessionId: 'run-1' });
    seed(service, 'a2', { status: 'pending_review', resultSessionId: 'run-2' });
    seed(service, 'a3', { status: 'active', config: { pendingReview: { resultSessionId: 'run-3', at: 1 } } });
    state.sessions.set('run-1', { origin: { kind: 'cron', id: 'job-a' } });
    state.sessions.set('run-2', { origin: { kind: 'cron', id: 'job-a' } });
    state.sessions.set('run-3', { origin: { kind: 'heartbeat', id: 'job-a' } });
    expect(service.listPendingReview()).toHaveLength(3);
    expect(service.countPendingReviewByTask()).toBe(1);
  });

  it('countPendingReviewByTask 把同一任务的多条待过目折成 1，对不上会话的记录仍各计 1', () => {
    const service = new SessionAutomationService();
    seed(service, 'a1', { status: 'pending_review', resultSessionId: 'run-1' });
    seed(service, 'a2', { status: 'active', resultSessionId: 'run-2', config: { pendingReview: { resultSessionId: 'run-2', at: 1 } } });
    seed(service, 'a3', { status: 'pending_review', resultSessionId: 'ghost-run' });
    state.sessions.set('run-1', { origin: { kind: 'cron', id: 'job-a' } });
    state.sessions.set('run-2', { origin: { kind: 'heartbeat', id: 'job-a' } });
    expect(service.countPendingReviewByTask()).toBe(2);
  });

  it('markReviewed 清标记；pending_review 状态转 archived', () => {
    const service = new SessionAutomationService();
    seed(service, 'once', { status: 'pending_review', config: { pendingReview: { at: 1 } } });
    seed(service, 'recurring', { status: 'active', config: { pendingReview: { resultSessionId: 'r', at: 2 } } });

    const onceAfter = service.markReviewed('once');
    expect(onceAfter?.status).toBe('archived');
    expect(onceAfter?.config?.pendingReview).toBeUndefined();

    const recurringAfter = service.markReviewed('recurring');
    expect(recurringAfter?.status).toBe('active');
    expect(recurringAfter?.config?.pendingReview).toBeUndefined();

    expect(service.countPendingReviewByTask()).toBe(0);
  });

  it('markReviewed 不存在的 id 返回 null', () => {
    const service = new SessionAutomationService();
    expect(service.markReviewed('ghost')).toBeNull();
  });

  it('recordEvent cancelled 清 pendingReview 标记（已删任务不占收件箱）', async () => {
    const service = new SessionAutomationService();
    seed(service, 'doomed', { status: 'active', config: { pendingReview: { resultSessionId: 'r', at: 1 } } });
    expect(service.countPendingReviewByTask()).toBe(1);
    await service.recordEvent({
      automationId: 'doomed',
      event: 'cancelled',
      status: 'cancelled',
      summary: '定时任务已删除。',
    });
    expect(service.countPendingReviewByTask()).toBe(0);
    expect(service.getById('doomed')?.status).toBe('cancelled');
  });
});
