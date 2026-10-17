// ============================================================================
// 幸存停车审批的 durable run 停靠（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME ④）
// ----------------------------------------------------------------------------
// 真实 SQLite + 真实 DurableRunRepository/RunRegistry，走真实 hydrate 入口：
// 幸存行所属会话的崩溃 run 被停靠成 waiting + guard_halt 后，listRecoverable
// （启动自动续跑清扫的取数口）不再带它——自动续跑不会替用户「批准」并重放这一轮。
// ============================================================================

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';
import { PendingApprovalRepository } from '../../../../src/host/services/core/repositories/PendingApprovalRepository';
import { hydrateApprovalGatesAtBoot } from '../../../../src/host/agent/parkedApprovalHydration';
import { computeLedgerArgsSurvival } from '../../../../src/host/agent/parkedApprovalSurvival';
import type { Message } from '../../../../src/shared/contract';

const planAttach = vi.fn(() => 0);
const launchAttach = vi.fn(() => 0);
vi.mock('../../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: planAttach }),
}));
vi.mock('../../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: launchAttach }),
}));

describe('parked approval durable run parking (through hydrate)', () => {
  it('幸存行 hydrate → run 停靠 waiting/guard_halt，不进 listRecoverable、进 listParkedForReclaim', async () => {
    const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'parked-approval-durable-')));
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
    `);
    const approvals = new PendingApprovalRepository(db);
    const sessionId = 'parked-approval-session';
    const runId = 'run-parked-approval';
    const toolCallId = 'call-parked-approval';
    const registry = new RunRegistry();
    try {
      // 首进程：建 run、以 running + crash_or_quit 形状「崩溃」落盘。
      registry.configureDurableKernel(new DurableRunKernel({
        stores: repository, ownerId: 'first-host', processInstanceId: 'first-process', leaseDurationMs: 100,
      }));
      await registry.startDurable({ runId, sessionId, workspace, cwd: workspace }, 1_000);
      await registry.checkpointDurable(runId, {
        now: 1_020,
        status: 'running',
        state: registry.getDurableCheckpointState(runId),
        engineCursor: registry.getDurableEnvelope(runId)?.cursor.engineCursor,
        pendingOperations: registry.getDurableEnvelope(runId)?.pendingOperations ?? [],
        childRuns: [],
        interruptCause: 'crash_or_quit',
        autoResumeCount: 0,
        events: [{ type: 'run_checkpointed', payload: {}, recordedAt: 1_020 }],
      });
      const before = await repository.listRecoverable(2_000, 100);
      expect(before.map((envelope) => envelope.runId)).toContain(runId);

      // 停车行（真原料：指纹 + 忠实）+ 承载它的 assistant 台账消息。
      const survival = computeLedgerArgsSurvival('Bash', { command: 'sleep 30' });
      approvals.insert({
        id: 'approval-parked-1',
        kind: 'tool_approval',
        agentId: null,
        agentName: null,
        coordinatorId: sessionId,
        payload: {
          sessionId,
          toolCallId,
          tool: 'Bash',
          type: 'command',
          permissionLevel: 'medium',
          requestedAt: 1_500,
          argsRef: { sessionId, toolCallId },
          argsFingerprint: survival.argsFingerprint,
          ledgerFaithful: true,
        },
        submittedAt: 1_500,
      });
      const ledgerMessages: Message[] = [
        {
          id: 'assistant-parked-approval',
          role: 'assistant',
          content: '',
          timestamp: 10,
          toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: 'sleep 30' } }],
        } as Message,
      ];

      // 重启路径：hydrate 幸存 → 默认停靠口被注入的仓储替换（真实函数照跑）。
      const counts = hydrateApprovalGatesAtBoot(approvals, 2_000, {
        loadSessionMessages: () => ledgerMessages,
        durableRunRepository: repository,
      });
      expect(counts.survived).toBe(1);
      await new Promise((resolve) => setImmediate(resolve)); // 同步 SQL 的 fire-and-forget 微任务收尾

      const envelope = await repository.get(runId);
      expect(envelope).toMatchObject({ status: 'waiting' });
      expect(envelope?.interruptCause ?? envelope?.interrupt_cause).toBe('guard_halt');

      const recoverable = await repository.listRecoverable(200_000, 100);
      expect(recoverable.map((envelope) => envelope.runId)).not.toContain(runId);

      const parkedForReclaim = await repository.listParkedForReclaim(200_000, 100);
      expect(parkedForReclaim.map((envelope) => envelope.runId)).toContain(runId);
    } finally {
      registry.clear();
      rmSync(workspace, { recursive: true, force: true });
      db.close();
    }
  });

  it('无幸存行时 hydrate 不碰 durable run（停靠只随幸存行走）', async () => {
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
    `);
    const approvals = new PendingApprovalRepository(db);
    try {
      const counts = hydrateApprovalGatesAtBoot(approvals, 2_000, {
        loadSessionMessages: () => [],
        durableRunRepository: repository,
      });
      expect(counts).toMatchObject({ survived: 0, parked: 0 });
      expect(await repository.listActiveRunRoster()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
