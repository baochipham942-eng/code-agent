// ============================================================================
// 无 cwd 停车审批 + 真实启动顺序：hydrateApprovalGatesAtBoot → recoverDurable
// （N-FIX-PARKED-APPROVAL-NOCWD-RUN-WAITING）
// 重启前的真实形状：root run 是 running（带 pending approval 操作，租约已过期＝进程已死），
// 而不是 seedWaitingRun 的 waiting+guard_halt。hydrate 先于 recoverDurable，
// 后者会把 running 的 run 回收并投影成 waiting——收口必须在 hydrate 时就把它收掉。
// 证据档位：hermetic-protocol（real file-backed SQLite + 真 kernel/registry）。
// ============================================================================

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyConversationBranchSchema } from '../../../src/host/services/core/database/schemaConversationBranch';
import { DurableRunRepository } from '../../../src/host/services/core/repositories/DurableRunRepository';
import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { DurableRunKernel } from '../../../src/host/runtime/durableRunKernel';
import { createDurableRecoveryRuntime } from '../../../src/host/runtime/durableRecoveryRuntime';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';
import { resumeSurvivingParkedApproval, type ParkedApprovalResumePorts } from '../../../src/host/agent/parkedApprovalResume';
import { computeLedgerArgsSurvival, describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { mapDurableRunToSessionStatus } from '../../../src/host/app/durableRunReadService';
import type { createLogger } from '../../../src/host/services/infra/logger';
import type { Message, Session } from '../../../src/shared/contract';
import type { PendingOperation } from '../../../src/shared/contract/durableRun';

vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: () => 0 }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: () => 0 }),
}));

describe('no-cwd parked approval: real boot order hydrate → recoverDurable (real SQLite)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let sessions: SessionRepository;
  let approvals: PendingApprovalRepository;
  let runs: DurableRunRepository;
  let first: RunRegistry;
  let second: RunRegistry;

  const kernelFor = (owner: string) => new DurableRunKernel({
    stores: runs, ownerId: owner, processInstanceId: `${owner}-process`, leaseDurationMs: 100,
  });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-nocwd-boot-')));
    db = new Database(path.join(dir, 'test.db'));
    db.pragma('foreign_keys = ON');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as ReturnType<typeof createLogger>;
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessions = new SessionRepository(db);
    approvals = new PendingApprovalRepository(db);
    runs = new DurableRunRepository(db);
    runs.migrate();
    first = new RunRegistry();
    first.configureDurableKernel(kernelFor('first-host'));
    second = new RunRegistry();
    second.configureDurableKernel(kernelFor('second-host'));
  });
  afterEach(() => {
    first.clear();
    second.clear();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const persistToolMessage = async (sessionId: string, message: Message) => {
    sessions.addMessage(sessionId, message);
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function seedSession(id: string, cwd: string | null, toolCallId: string) {
    sessions.createSession({
      id, title: id, modelConfig: { provider: 'openai', model: 'gpt-5' },
      ...(cwd ? { workingDirectory: cwd } : {}), createdAt: 1, updatedAt: 1, status: 'running',
    } as Session);
    sessions.addMessage(id, {
      id: `${id}-assistant`, role: 'assistant', content: '', timestamp: 10,
      toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: 'echo hi' } }],
    } as Message);
    approvals.insert({
      id: `appr-${id}`, kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: id,
      payload: {
        sessionId: id, toolCallId, tool: 'Bash', type: 'command', permissionLevel: 'medium', requestedAt: 1_000,
        argsRef: { sessionId: id, toolCallId },
        ...computeLedgerArgsSurvival('Bash', { command: 'echo hi' }),
      },
      submittedAt: 1_000,
    });
  }

  /** 重启前：run 是 running，带 waiting 的 approval 操作，租约 1_100 过期（进程已死）。 */
  async function seedRunningApprovalRun(runId: string, sessionId: string) {
    await first.startDurable({ runId, sessionId, workspace: dir, cwd: dir }, 1_000);
    const operation: PendingOperation = {
      ...kernelFor('seed').prepareOperation({
        runId, operationId: `approval:appr-${sessionId}`, logicalOperationId: `appr-${sessionId}`, attempt: 1,
        kind: 'approval', sideEffect: false, canDeduplicate: true, requiresHumanConfirmation: true,
        providerOperationId: `approval:appr-${sessionId}`, now: 1_010,
      }),
      status: 'waiting',
    };
    await first.checkpointDurable(runId, {
      now: 1_020, status: 'running',
      state: first.getDurableCheckpointState(runId),
      engineCursor: first.getDurableEnvelope(runId)?.cursor.engineCursor,
      pendingOperations: [operation], childRuns: [],
      events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_020 }],
    });
    first.clear(); // 进程死亡：不再续租
    expect((await runs.get(runId))?.status).toBe('running');
  }

  const deniedResults = (sessionId: string) => sessions.getMessages(sessionId)
    .filter((m) => m.role === 'tool').flatMap((m) => m.toolResults ?? []);

  it('无 cwd 行 + running 的死进程 run：hydrate → recoverDurable 后 run 是 cancelled/interrupted，不再被刷新', async () => {
    seedSession('s1', null, 'call-s1');
    await seedRunningApprovalRun('run-1', 's1');

    hydrateApprovalGatesAtBoot(approvals, 2_000, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: (id) => sessions.getSession(id)?.workingDirectory || null,
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();
    await second.recoverDurable(2_010);

    expect(approvals.getById('appr-s1')).toMatchObject({ status: 'rejected' });
    const results = deniedResults('s1');
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe(describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'));
    const env = await runs.get('run-1');
    expect(env?.status).not.toBe('waiting');
    expect(env?.status).toBe('cancelled');
    expect(mapDurableRunToSessionStatus(env!.status)).toBe('interrupted');

    // 后续恢复 / 租约心跳 tick：终态 run 的 updated_at 不再变化。
    const updatedAt = (): number => (db.prepare('SELECT updated_at FROM durable_runs WHERE run_id = ?').get('run-1') as { updated_at: number }).updated_at;
    const before = updatedAt();
    await second.recoverDurable(3_000);
    await second.recoverDurable(4_000);
    expect(updatedAt()).toBe(before);
    expect((await runs.get('run-1'))?.status).toBe('cancelled');
  });

  it('同批启动里带 cwd 的幸存行仍只执行一次，其 running run 不被收口', async () => {
    seedSession('s2', '/work/s2', 'call-s2');
    await seedRunningApprovalRun('run-2', 's2');

    hydrateApprovalGatesAtBoot(approvals, 2_000, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: (id) => sessions.getSession(id)?.workingDirectory || null,
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();
    await second.recoverDurable(2_010);
    expect(approvals.getById('appr-s2')).toMatchObject({ status: 'pending' });
    expect((await runs.get('run-2'))?.status).toBe('waiting');

    const executeTool = vi.fn(async () => ({ success: true, output: 'hi' }));
    const ports = {
      repo: approvals,
      loadMessages: (id: string) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s2',
      executeTool,
      persistToolMessage,
      now: () => 5_000,
      durableRunRepository: runs,
    } as unknown as ParkedApprovalResumePorts;
    await resumeSurvivingParkedApproval({ requestId: 'appr-s2', response: 'allow', now: 5_000, ports });
    await resumeSurvivingParkedApproval({ requestId: 'appr-s2', response: 'allow', now: 5_001, ports });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it('快速重启：hydrate 时租约未过期 → 清扫器两次认领（先未过期、后过期）后 run 是 cancelled，从不 waiting', async () => {
    seedSession('s3', null, 'call-s3');
    await seedRunningApprovalRun('run-3', 's3'); // 租约 1_100 到期
    const runtime = createDurableRecoveryRuntime({
      registry: second, kernel: kernelFor('second-host'), dataDir: dir,
    });

    hydrateApprovalGatesAtBoot(approvals, 1_050, { // 租约仍有效：此刻不能碰
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: (id) => sessions.getSession(id)?.workingDirectory || null,
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();
    expect(approvals.getById('appr-s3')).toMatchObject({ status: 'rejected' });
    expect((await runs.get('run-3'))?.status).toBe('running'); // 活租约：绝不动

    await runtime.recoverAndDispatch(1_060); // 租约仍有效，不被认领
    expect((await runs.get('run-3'))?.status).toBe('running');
    await runtime.recoverAndDispatch(1_500); // 过期后：先收口，再认领（已无可认领）

    const env = await runs.get('run-3');
    expect(env?.status).toBe('cancelled');
    expect(mapDurableRunToSessionStatus(env!.status)).toBe('interrupted');
    const updatedAt = (): number => (db.prepare('SELECT updated_at FROM durable_runs WHERE run_id = ?').get('run-3') as { updated_at: number }).updated_at;
    const before = updatedAt();
    await runtime.recoverAndDispatch(2_000);
    await runtime.recoverAndDispatch(3_000);
    expect(updatedAt()).toBe(before);
    expect((await runs.get('run-3'))?.status).toBe('cancelled');
    await runtime.shutdown();
  });
});
