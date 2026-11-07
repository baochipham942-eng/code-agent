// N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-REALRUN-FU2：运行详情「为什么停了」的 host 查询。
// real file-backed SQLite（sessions + pending_approvals 全真）；getDatabase 指向本文件的文件库。
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const warn = vi.hoisted(() => vi.fn());
const dbState = vi.hoisted(() => ({ repo: null as unknown }));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getPendingApprovalRepo: () => dbState.repo }),
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/services/infra/logger')>();
  const stub = () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn(), child: () => stub() });
  return { ...actual, createLogger: () => stub() };
});

import { applySchema } from '../../../src/host/services/core/database/schema';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { SessionAutomationService } from '../../../src/host/services/sessionAutomation/sessionAutomationService';

const DAY = 86_400_000;

describe('getVoidedApprovalReason (real SQLite file)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let sessions: SessionRepository;
  let approvals: PendingApprovalRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'voided-reason-')));
    db = new Database(path.join(dir, 'test.db'));
    applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
    sessions = new SessionRepository(db);
    approvals = new PendingApprovalRepository(db);
    dbState.repo = approvals;
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedVoided(id: string, sessionId: string, feedback: string, resolvedAt: number) {
    sessions.createSessionWithId(sessionId, {
      title: sessionId,
      modelConfig: { provider: 'openai', model: 'm' },
      origin: { kind: 'cron', id: 'job-1' } as never,
      sourceRunId: `exec-${sessionId}`,
    });
    approvals.insert({
      id, kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: sessionId,
      payload: { sessionId, tool: 'Bash', requestedAt: 1_000 } as never,
      submittedAt: 1_000,
    });
    approvals.resolve({ id, status: 'rejected', feedback, resolvedAt });
  }

  it('③a 重启后作废的行 → 与收件箱同一句话；无关会话 → null', () => {
    seedVoided('r1', 's1', 'Auto-rejected after restart: expired_after_restart_24h', Date.now());
    sessions.createSessionWithId('other', { title: 'o', modelConfig: { provider: 'openai', model: 'm' } });
    const svc = new SessionAutomationService();
    const sentence = svc.getVoidedApprovalReason('s1');
    expect(sentence).toBe(describeParkedApprovalClosure('expired_after_restart_24h'));
    expect(sentence).toContain('24 小时');
    expect(svc.getVoidedApprovalReason('other')).toBeNull();
    expect(svc.getVoidedApprovalReason('missing')).toBeNull();
  });

  it('③b 超过 3 天保留期的行仍能解析（运行页不受收件箱保留期限制），收件箱却已隐藏', () => {
    seedVoided('r2', 's2', 'Auto-rejected after restart: args_unavailable (session working directory unavailable)', Date.now() - 10 * DAY);
    const svc = new SessionAutomationService();
    expect(svc.getVoidedApprovalReason('s2')).toBe(
      describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'),
    );
    expect(svc.listParkedApprovals().filter((i) => i.status === 'voided')).toHaveLength(0);
  });

  it('④ 原因码认不出的作废行 → null + warn 留痕；非重启作废的 rejected 行 → null 且不 warn', () => {
    seedVoided('r3', 's3', 'Auto-rejected after restart: something_new', Date.now());
    seedVoided('r4', 's4', 'User denied', Date.now());
    const svc = new SessionAutomationService();
    expect(svc.getVoidedApprovalReason('s3')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(svc.getVoidedApprovalReason('s4')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
