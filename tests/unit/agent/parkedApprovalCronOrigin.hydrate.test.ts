// ============================================================================
// N-CRON-PARKED-APPROVAL-STALE-AFTER-RESTART：无人值守（cron / heartbeat）停车审批重启即作废
// 真实 SQLite + 真实 hydrate + 真实收件箱读径；交互会话（无 origin）照旧 24h 存活。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import { runStartupMaintenance } from '../../../src/host/services/core/database/startupMaintenance';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { MemoryRepository } from '../../../src/host/services/core/repositories/MemoryRepository';
import { PermissionDecisionRepository } from '../../../src/host/services/core/repositories/PermissionDecisionRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { ToolExecutionEventRepository } from '../../../src/host/services/core/repositories/ToolExecutionEventRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import type { Message, Session } from '../../../src/shared/contract';
import { isParkedApprovalClosureSentence } from '../../../src/shared/parkedApprovalClosure';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';

const planAttach = vi.fn(() => 0);
const launchAttach = vi.fn(() => 0);
vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: planAttach }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: launchAttach }),
}));

const dbState = vi.hoisted(() => ({
  sessionRepo: null as SessionRepository | null,
  repo: null as PendingApprovalRepository | null,
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => dbState.repo,
    getSession: (sessionId: string) => dbState.sessionRepo?.getSession(sessionId) ?? null,
  }),
}));
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../../../src/host/services/infra/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/host/services/infra/logger')>()),
  createLogger: () => logSpies,
}));

import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';

const H = 3_600_000;
const SENTENCE = '所属运行已结束，没有执行；下次触发会重新询问你。';
const INTERRUPTED_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';

describe('cron / heartbeat origin parked approvals are voided at restart', () => {
  let db: BetterSqlite3.Database;
  let dbDir: string;
  let sessionRepo: SessionRepository;
  let repo: PendingApprovalRepository;
  const closeParkedWaitingRunForSession = vi.fn(async (_input: { sessionId: string }) => true);
  const durableRunRepoStub = {
    listActiveRunRoster: async () => [],
    closeParkedWaitingRunForSession,
    replaceRecoveryProjection: async () => ({}),
  } as unknown as import('../../../src/host/services/core/repositories/DurableRunRepository').DurableRunRepository;
  const hydrate = (now: number) => hydrateApprovalGatesAtBoot(repo, now, {
    loadSessionMessages: (id) => sessionRepo.getMessages(id),
    durableRunRepository: durableRunRepoStub,
    persistToolMessage: async (sessionId, message) => {
      sessionRepo.addMessage(sessionId, message, { provenanceKind: 'crash-recovery' });
    },
  });

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'parked-cron-origin-'));
    db = new Database(join(dbDir, 'code-agent.db'));
    db.pragma('foreign_keys = ON');
    applySchema(db, logSpies as never);
    applySessionsMigrations(db, logSpies as never);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessionRepo = new SessionRepository(db);
    repo = new PendingApprovalRepository(db);
    dbState.sessionRepo = sessionRepo;
    dbState.repo = repo;
    vi.clearAllMocks();
  });
  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  function seed(id: string, origin: Session['origin'] | undefined, requestedAt: number): void {
    sessionRepo.createSession({
      id,
      title: id,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      workingDirectory: `/workspace/${id}`,
      ...(origin ? { origin } : {}),
      createdAt: 1,
      updatedAt: 1,
      status: 'running',
    } as Session);
    const toolCallId = `call-${id}`;
    const command = `echo ${id}`;
    sessionRepo.addMessage(id, {
      id: `${id}-assistant`,
      role: 'assistant',
      content: '',
      timestamp: 10,
      toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command } }],
    } as Message);
    const survival = computeLedgerArgsSurvival('Bash', { command });
    repo.insert({
      id: `row-${id}`,
      kind: 'tool_approval',
      agentId: null,
      agentName: null,
      coordinatorId: id,
      payload: {
        sessionId: id,
        toolCallId,
        tool: 'Bash',
        type: 'command',
        permissionLevel: 'medium',
        requestedAt,
        argsRef: { sessionId: id, toolCallId },
        argsFingerprint: survival.argsFingerprint,
        ledgerFaithful: survival.ledgerFaithful,
      },
      submittedAt: requestedAt,
    });
  }

  async function inboxIds(): Promise<string[]> {
    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    return new SessionAutomationService().listParkedApprovals().map((item) => item.id);
  }

  it('10 个 cron + 1 个 heartbeat 2h 老 Bash 审批被作废，交互会话那条照旧存活', async () => {
    const now = Date.now();
    const cronIds = Array.from({ length: 10 }, (_, i) => `cron-${i}`);
    for (const id of cronIds) seed(id, { kind: 'cron', id: 'job-1' } as Session['origin'], now - 2 * H);
    seed('hb', { kind: 'heartbeat', id: 'hb-1' } as Session['origin'], now - 2 * H);
    seed('interactive', undefined, now - 2 * H);

    const counts = hydrate(now);
    expect(counts.survived).toBe(1);
    expect(counts.parked).toBe(11);

    for (const id of [...cronIds, 'hb']) {
      const row = repo.getById(`row-${id}`);
      expect(row?.status).toBe('rejected');
      expect(row?.feedback).toBe('Auto-rejected after restart: run_ended_after_restart');
      expect(logSpies.warn).toHaveBeenCalledWith(
        'Voided parked approval of unattended run after restart',
        expect.objectContaining({
          requestId: `row-${id}`,
          sessionId: id,
          reason: 'run_ended_after_restart',
          originKind: id === 'hb' ? 'heartbeat' : 'cron',
        }),
      );
    }
    await vi.waitFor(() => {
      for (const id of [...cronIds, 'hb']) {
        const tool = sessionRepo.getMessages(id).find((m) => m.role === 'tool');
        expect(JSON.stringify(tool?.toolResults)).toContain('所属运行已结束');
        expect(JSON.stringify(tool?.toolResults)).toContain(SENTENCE);
      }
    });
    // 每个被作废的运行都走既有 closeSessionParkedRun 收口；交互会话不收口
    await vi.waitFor(() => expect(closeParkedWaitingRunForSession).toHaveBeenCalledTimes(11));
    const closedSessions = closeParkedWaitingRunForSession.mock.calls.map((c) => c[0].sessionId);
    expect(closedSessions).not.toContain('interactive');
    expect(closedSessions).toContain('cron-0');

    expect(repo.getById('row-interactive')?.status).toBe('pending');
    expect(await inboxIds()).toEqual(['row-interactive']);
    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    expect(new SessionAutomationService().listParkedApprovals()[0]).toMatchObject({ displayTool: '重启前发起 · Bash' });
  });

  it('isParkedApprovalClosureSentence 认得运行已结束句（渲染端读作「未执行」而非执行失败）', () => {
    expect(isParkedApprovalClosureSentence(SENTENCE)).toBe(true);
  });

  it('hydrate 后 getVoidedApprovalReason(cron 会话) 返回运行已结束句，且不 warn unparseable；收件箱不列灰行', async () => {
    const now = Date.now();
    seed('cron-r', { kind: 'cron', id: 'job-1' } as Session['origin'], now - 2 * H);
    seed('interactive-r', undefined, now - 2 * H);
    hydrate(now);
    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const svc = new SessionAutomationService();
    expect(svc.getVoidedApprovalReason('cron-r')).toBe(SENTENCE);
    expect(logSpies.warn).not.toHaveBeenCalledWith('Voided approval reason unparseable', expect.anything());
    expect(svc.listParkedApprovals().map((item) => item.id)).toEqual(['row-interactive-r']);
  });

  it('cron 来源超过 24h 的行仍报 expired_after_restart_24h（年龄判据先行）', () => {
    const now = Date.now();
    seed('cron-old', { kind: 'cron', id: 'job-1' } as Session['origin'], now - 25 * H);
    hydrate(now);
    expect(repo.getById('row-cron-old')?.feedback).toBe('Auto-rejected after restart: expired_after_restart_24h');
  });

  it('startupMaintenance 与 hydrate 一致：cron 的 toolCall 写 INTERRUPTED 占位，交互幸存行不写', () => {
    const now = Date.now() - 1_000;
    seed('cron-m', { kind: 'cron', id: 'job-1' } as Session['origin'], now);
    seed('interactive-m', undefined, now);
    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo: new ToolExecutionEventRepository(db),
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      pendingApprovalRepo: repo,
      logger: logSpies as never,
      step: vi.fn(),
    });
    const cronMessages = sessionRepo.getMessages('cron-m');
    expect(cronMessages).toHaveLength(2);
    expect(cronMessages[1]).toMatchObject({
      role: 'tool',
      toolResults: [{ toolCallId: 'call-cron-m', error: INTERRUPTED_PLACEHOLDER }],
    });
    expect(sessionRepo.getMessages('interactive-m')).toHaveLength(1);
  });
});
