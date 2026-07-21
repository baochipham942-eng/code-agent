// A4 待过目：markReviewed / countPendingReview / summarizeSessions.pendingReviewCount
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
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
});

describe('pending review', () => {
  it('countPendingReview 同时统计 status=pending_review 与 config.pendingReview 标记', () => {
    const service = new SessionAutomationService();
    seed(service, 'a1', { status: 'pending_review' });
    seed(service, 'a2', { status: 'active', config: { pendingReview: { resultSessionId: 'r2', at: 1 } } });
    seed(service, 'a3', { status: 'active' });
    expect(service.countPendingReview()).toBe(2);
    expect(service.listPendingReview().map((r) => r.id).sort()).toEqual(['a1', 'a2']);
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

    expect(service.countPendingReview()).toBe(0);
  });

  it('markReviewed 不存在的 id 返回 null', () => {
    const service = new SessionAutomationService();
    expect(service.markReviewed('ghost')).toBeNull();
  });

  it('summarizeSessions 带 pendingReviewCount', () => {
    const service = new SessionAutomationService();
    seed(service, 'a1', { status: 'active', config: { pendingReview: { at: 1 } } });
    seed(service, 'a2', { status: 'active' });
    const summary = service.summarizeSessions(['src-1'])['src-1'];
    expect(summary.pendingReviewCount).toBe(1);
  });
});
