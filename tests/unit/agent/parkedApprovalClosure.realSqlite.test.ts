// ============================================================================
// 停车审批收口后会话不再 running、run 离开 waiting
// （N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-RESUME-FU1-FU1）
// 证据档：real file-backed SQLite（sessions/messages/pending_approvals/durable_runs 全真）+ 真 hydrate/resume。
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
import { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';
import { resumeSurvivingParkedApproval, type ParkedApprovalResumePorts } from '../../../src/host/agent/parkedApprovalResume';
import { computeLedgerArgsSurvival, describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';
import { mapDurableRunToSessionStatus } from '../../../src/host/app/durableRunReadService';
import type { createLogger } from '../../../src/host/services/infra/logger';
import type { Message, Session } from '../../../src/shared/contract';

vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: () => 0 }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: () => 0 }),
}));

const HOUR = 3_600_000;

describe('parked approval closure → ledger denied result + run leaves waiting (real SQLite)', () => {
  let dir: string;
  let db: BetterSqlite3.Database;
  let sessions: SessionRepository;
  let approvals: PendingApprovalRepository;
  let runs: DurableRunRepository;
  let registry: RunRegistry;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-closure-')));
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
    registry = new RunRegistry();
    registry.configureDurableKernel(new DurableRunKernel({
      stores: runs, ownerId: 'first-host', processInstanceId: 'first-process', leaseDurationMs: 100,
    }));
  });
  afterEach(() => {
    registry.clear();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const persistToolMessage = async (sessionId: string, message: Message) => {
    sessions.addMessage(sessionId, message);
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function seedSession(id: string, cwd: string | null, command = 'echo hi', toolCallId = `call-${id}`) {
    sessions.createSession({
      id, title: id, modelConfig: { provider: 'openai', model: 'gpt-5' },
      ...(cwd ? { workingDirectory: cwd } : {}), createdAt: 1, updatedAt: 1, status: 'running',
    } as Session);
    sessions.addMessage(id, {
      id: `${id}-assistant`, role: 'assistant', content: '', timestamp: 10,
      toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command } }],
    } as Message);
  }

  function seedRow(id: string, sessionId: string, toolCallId: string, requestedAt: number, command = 'echo hi') {
    approvals.insert({
      id, kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: sessionId,
      payload: {
        sessionId, toolCallId, tool: 'Bash', type: 'command', permissionLevel: 'medium', requestedAt,
        argsRef: { sessionId, toolCallId },
        ...computeLedgerArgsSurvival('Bash', { command }),
      },
      submittedAt: requestedAt,
    });
  }

  async function seedWaitingRun(runId: string, sessionId: string) {
    await registry.startDurable({ runId, sessionId, workspace: dir, cwd: dir }, 1_000);
    await registry.checkpointDurable(runId, {
      now: 1_020, status: 'waiting',
      state: registry.getDurableCheckpointState(runId),
      engineCursor: registry.getDurableEnvelope(runId)?.cursor.engineCursor,
      pendingOperations: registry.getDurableEnvelope(runId)?.pendingOperations ?? [],
      childRuns: [], interruptCause: 'guard_halt', autoResumeCount: 0,
      events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_020 }],
    });
    expect((await runs.get(runId))?.status).toBe('waiting');
  }

  const deniedResults = (sessionId: string) => sessions.getMessages(sessionId)
    .filter((m) => m.role === 'tool').flatMap((m) => m.toolResults ?? []);

  it('① 无 cwd 的 args_unavailable 行：行 rejected、台账有 denied 结果句、run cancelled、投影 interrupted', async () => {
    seedSession('s1', null);
    seedRow('a1', 's1', 'call-s1', 1_000);
    await seedWaitingRun('run-1', 's1');
    expect(mapDurableRunToSessionStatus('waiting')).toBe('running'); // 修前的僵尸投影

    hydrateApprovalGatesAtBoot(approvals, 2_000, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: (id) => sessions.getSession(id)?.workingDirectory || null,
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();

    expect(approvals.getById('a1')).toMatchObject({ status: 'rejected' });
    const results = deniedResults('s1');
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe(describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'));
    const env = await runs.get('run-1');
    expect(env?.status).toBe('cancelled');
    expect(mapDurableRunToSessionStatus(env!.status)).toBe('interrupted');
  });

  it('② expired_after_restart_24h（25h 老行）：同样落句 + 收 run', async () => {
    seedSession('s2', '/work/s2');
    const requestedAt = 1_000;
    seedRow('a2', 's2', 'call-s2', requestedAt);
    await seedWaitingRun('run-2', 's2');

    hydrateApprovalGatesAtBoot(approvals, requestedAt + 25 * HOUR, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s2',
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();

    expect(approvals.getById('a2')?.feedback).toBe('Auto-rejected after restart: expired_after_restart_24h');
    expect(deniedResults('s2')[0].error).toBe('这一步等你确认超过 24 小时，已自动作废，没有执行。');
    expect((await runs.get('run-2'))?.status).toBe('cancelled');
  });

  it('③ 点击批准：命令只执行一次、run 离开 waiting；二次点击不再执行', async () => {
    seedSession('s3', '/work/s3');
    seedRow('a3', 's3', 'call-s3', 1_000);
    await seedWaitingRun('run-3', 's3');
    const executeTool = vi.fn(async () => ({ success: true, output: 'hi' }));
    const ports = {
      repo: approvals,
      loadMessages: (id: string) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s3',
      executeTool,
      persistToolMessage,
      now: () => 2_000,
      durableRunRepository: runs,
    } as unknown as ParkedApprovalResumePorts;

    const first = await resumeSurvivingParkedApproval({ requestId: 'a3', response: 'allow', now: 2_000, ports });
    expect(first).toMatchObject({ handled: true, status: 'executed' });
    const second = await resumeSurvivingParkedApproval({ requestId: 'a3', response: 'allow', now: 2_001, ports });
    expect(second.handled).toBe(false);

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(sessions.getMessages('s3').filter((m) => m.role === 'tool')).toHaveLength(1);
    expect((await runs.get('run-3'))?.status).toBe('cancelled');
  });

  it('④ 同会话还有另一条幸存待批行：run 保持停靠，不收口', async () => {
    seedSession('s4', '/work/s4', 'echo a', 'call-a');
    sessions.addMessage('s4', {
      id: 's4-assistant-2', role: 'assistant', content: '', timestamp: 11,
      toolCalls: [{ id: 'call-b', name: 'Bash', arguments: { command: 'echo b' } }],
    } as Message);
    seedRow('a4', 's4', 'call-a', 1_000, 'echo a');
    seedRow('b4', 's4', 'call-b', 1_000, 'echo b');
    await seedWaitingRun('run-4', 's4');
    const ports = {
      repo: approvals,
      loadMessages: (id: string) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s4',
      executeTool: vi.fn(async () => ({ success: true, output: 'ok' })),
      persistToolMessage,
      now: () => 2_000,
      durableRunRepository: runs,
    } as unknown as ParkedApprovalResumePorts;

    await resumeSurvivingParkedApproval({ requestId: 'a4', response: 'allow', now: 2_000, ports });

    expect(approvals.getById('b4')?.status).toBe('pending');
    expect((await runs.get('run-4'))?.status).toBe('waiting');
  });

  it('④ hydrate：会话里有幸存行 + 被拒行 → 不收 run', async () => {
    seedSession('s5', '/work/s5', 'echo a', 'call-a');
    sessions.addMessage('s5', {
      id: 's5-assistant-2', role: 'assistant', content: '', timestamp: 11,
      toolCalls: [{ id: 'call-b', name: 'Bash', arguments: { command: 'echo b' } }],
    } as Message);
    seedRow('a5', 's5', 'call-a', 1_000, 'echo a');
    approvals.insert({
      id: 'b5', kind: 'tool_approval', agentId: null, agentName: null, coordinatorId: 's5',
      payload: { sessionId: 's5', toolCallId: 'call-b', tool: 'Bash', type: 'command', permissionLevel: 'medium', requestedAt: 1_000, argsRef: { sessionId: 's5', toolCallId: 'call-b' } },
      submittedAt: 1_000,
    });
    await seedWaitingRun('run-5', 's5');

    const counts = hydrateApprovalGatesAtBoot(approvals, 2_000, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s5',
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();

    expect(counts).toMatchObject({ survived: 1, parked: 1 });
    expect((await runs.get('run-5'))?.status).toBe('waiting');
  });

  it('r1 hydrate：审批早于该会话当前 waiting run（run2）→ 不收 run2', async () => {
    seedSession('s6', null);
    seedRow('a6', 's6', 'call-s6', 500); // 审批发起于 run 创建（1_000）之前 → 属于旧 run1
    await seedWaitingRun('run-6', 's6');

    hydrateApprovalGatesAtBoot(approvals, 2_000, {
      loadSessionMessages: (id) => sessions.getMessages(id),
      resolveWorkingDirectory: () => null,
      durableRunRepository: runs,
      persistToolMessage,
    });
    await flush();

    expect(approvals.getById('a6')?.status).toBe('rejected');
    expect((await runs.get('run-6'))?.status).toBe('waiting');
  });

  it('r1 点击：审批早于该会话当前 waiting run（run2）→ 执行后不收 run2', async () => {
    seedSession('s7', '/work/s7');
    seedRow('a7', 's7', 'call-s7', 500);
    await seedWaitingRun('run-7', 's7');
    const ports = {
      repo: approvals,
      loadMessages: (id: string) => sessions.getMessages(id),
      resolveWorkingDirectory: () => '/work/s7',
      executeTool: vi.fn(async () => ({ success: true, output: 'ok' })),
      persistToolMessage,
      now: () => 2_000,
      durableRunRepository: runs,
    } as unknown as ParkedApprovalResumePorts;

    const out = await resumeSurvivingParkedApproval({ requestId: 'a7', response: 'allow', now: 2_000, ports });

    expect(out).toMatchObject({ handled: true, status: 'executed' });
    expect((await runs.get('run-7'))?.status).toBe('waiting');
  });
});
