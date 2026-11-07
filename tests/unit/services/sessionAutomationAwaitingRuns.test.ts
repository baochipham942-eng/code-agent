import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

// N-CRON-UNATTENDED-BASH-PARK-STUCK：listAwaitingApprovalRuns 的 host 侧 join。
// 真 sqlite（pending_approvals + sessions.origin/sourceRunId），getDatabase 指到本文件
// 内存库（parkedApprovalSurvival.hydrate 测试同款 mock 范式）。

const warn = vi.hoisted(() => vi.fn());
const dbState = vi.hoisted(() => ({
  sessionRepo: null as { getSession: (id: string) => { origin?: { kind: string; id?: string }; sourceRunId?: string } | null } | null,
  repo: null as PendingApprovalRepository | null,
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => dbState.repo,
    getSession: (sessionId: string) => dbState.sessionRepo?.getSession(sessionId) ?? null,
  }),
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  const stub = () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => stub() });
  return { ...actual, createLogger: () => stub() };
});

import { applySchema } from '../../../src/host/services/core/database/schema';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

let db: BetterSqlite3.Database;
let sessionRepo: SessionRepository;
let approvalRepo: PendingApprovalRepository;

const insertApproval = (id: string, sessionId: string | null, submittedAt = 1_000) => {
  db.prepare(
    "INSERT INTO pending_approvals (id, kind, status, payload_json, coordinator_id, submitted_at) VALUES (?, 'tool_approval', 'pending', ?, ?, ?)",
  ).run(id, JSON.stringify({ sessionId, tool: 'Bash', requestedAt: submittedAt }), sessionId, submittedAt);
};

const insertSession = (id: string, origin: { kind: string; id?: string } | null, sourceRunId?: string) => {
  sessionRepo.createSessionWithId(id, {
    title: 's',
    modelConfig: { provider: 'openai', model: 'm' },
    ...(origin ? { origin: origin as never } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
  });
};

describe('listAwaitingApprovalRuns (host join, N-CRON-UNATTENDED-BASH-PARK-STUCK)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    sessionRepo = new SessionRepository(db);
    approvalRepo = new PendingApprovalRepository(db);
    dbState.sessionRepo = sessionRepo;
    dbState.repo = approvalRepo;
  });

  afterEach(() => {
    db.close();
    dbState.sessionRepo = null;
    dbState.repo = null;
  });

  it('① cron 会话的 pending 审批 → {jobId, executionId}；交互（manual）会话不在结果', async () => {
    insertSession('sess-cron', { kind: 'cron', id: 'job-1' }, 'exec-1');
    insertSession('sess-manual', { kind: 'manual' });
    insertApproval('req-1', 'sess-cron', 5_000);
    insertApproval('req-2', 'sess-manual', 6_000);

    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const svc = new SessionAutomationService();
    const out = svc.listAwaitingApprovalRuns();

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ jobId: 'job-1', executionId: 'exec-1', requestId: 'req-1', requestedAt: 5_000 });
  });

  it('⑤ commandPreview 取 argsPreview，缺省回落 argsSummary，都没有则不带该字段', async () => {
    insertSession('sess-a', { kind: 'cron', id: 'job-a' }, 'exec-a');
    insertSession('sess-b', { kind: 'cron', id: 'job-b' }, 'exec-b');
    insertSession('sess-c', { kind: 'cron', id: 'job-c' }, 'exec-c');
    const put = (id: string, sid: string, payload: Record<string, unknown>) =>
      db.prepare(
        "INSERT INTO pending_approvals (id, kind, status, payload_json, coordinator_id, submitted_at) VALUES (?, 'tool_approval', 'pending', ?, ?, 1)",
      ).run(id, JSON.stringify({ sessionId: sid, tool: 'Bash', requestedAt: 1, ...payload }), sid);
    put('r-a', 'sess-a', { argsPreview: 'node refresh.js', argsSummary: 'ignored' });
    put('r-b', 'sess-b', { argsSummary: 'ls /tmp' });
    put('r-c', 'sess-c', {});

    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const out = new SessionAutomationService().listAwaitingApprovalRuns();
    const byJob = Object.fromEntries(out.map((r) => [r.jobId, r]));
    expect(byJob['job-a'].commandPreview).toBe('node refresh.js');
    expect(byJob['job-b'].commandPreview).toBe('ls /tmp');
    expect('commandPreview' in byJob['job-c']).toBe(false);
  });

  it('② 会话缺失 → 跳过并 warn（reason: session row missing）；非 cron origin → 不进结果', async () => {
    insertApproval('req-gone', 'sess-missing', 1);
    insertSession('sess-sub', { kind: 'subagent' });
    insertApproval('req-sub', 'sess-sub', 2);

    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const svc = new SessionAutomationService();
    const out = svc.listAwaitingApprovalRuns();

    expect(out).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'Awaiting-approval run skipped: session row missing',
      expect.objectContaining({ requestId: 'req-gone', sessionId: 'sess-missing' }),
    );
  });

  it('heartbeat 也算；sourceRunId 缺席 → executionId null；payload 无 sessionId → warn', async () => {
    insertSession('sess-hb', { kind: 'heartbeat', id: 'job-hb' });
    insertApproval('req-hb', 'sess-hb', 7);
    db.prepare(
      "INSERT INTO pending_approvals (id, kind, status, payload_json, coordinator_id, submitted_at) VALUES ('req-nosid', 'tool_approval', 'pending', '{}', NULL, 8)",
    ).run();

    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const svc = new SessionAutomationService();
    const out = svc.listAwaitingApprovalRuns();

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ jobId: 'job-hb', executionId: null, requestId: 'req-hb' });
    expect(warn).toHaveBeenCalledWith(
      'Awaiting-approval run skipped: no sessionId',
      expect.objectContaining({ requestId: 'req-nosid' }),
    );
  });
});
