// ============================================================================
// 重启后停车审批「批准即从台账执行一次」（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME ③）
// ----------------------------------------------------------------------------
// 真实 SQLite pending_approvals + 注入式执行端口：
//   批准 → 认领赢家执行一次、结果消息落原会话；重复/并发点击只执行一次；
//   拒绝不执行并落 denied 结果；台账 args 漂移（截断/改写）→ args_unavailable 拒执行；
//   认领后崩溃形状（行已 approved）→ 再点不执行。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import type { Message } from '../../../src/shared/contract';
import type { PermissionResponse } from '../../../src/shared/contract/permission';

describe('parked approval resume from message ledger', () => {
  let db: BetterSqlite3.Database;
  let repo: PendingApprovalRepository;
  let executions: number;
  let sideEffectLog: string[];
  let persistedMessages: Message[];
  let messages: Message[];
  const sessionId = 'resume-session';
  const toolCallId = 'call-resume';
  const now = 5_000;

  function buildPorts(overrides: Partial<{
    executeToolArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  }> = {}) {
    return {
      repo,
      loadMessages: () => messages,
      resolveWorkingDirectory: () => '/tmp',
      async executeTool(input: { name: string; arguments: Record<string, unknown> }) {
        executions += 1;
        sideEffectLog.push(`echo >> ${String(input.arguments.command ?? '')}`);
        return {
          success: true,
          output: `executed #${executions}`,
          metadata: { attempt: executions },
        };
      },
      async persistToolMessage(_sessionId: string, message: Message) {
        persistedMessages.push(message);
        messages = [...messages, message];
      },
      now: () => now,
      ...overrides,
    };
  }

  const resume = (response: PermissionResponse, ports = buildPorts()) =>
    resumeSurvivingParkedApproval({ requestId: 'resume-1', response, now, ports });

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
    `);
    repo = new PendingApprovalRepository(db);
    executions = 0;
    sideEffectLog = [];
    persistedMessages = [];
    messages = [
      {
        id: 'resume-user',
        role: 'user',
        content: 'run it',
        timestamp: 1,
      },
      {
        id: 'resume-assistant',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: 'sleep 30' } }],
      },
    ] as Message[];
  });
  afterEach(() => db.close());

  function seedSurvivorRow(input: { fingerprintOf?: string; requestedAt?: number } = {}): void {
    const command = input.fingerprintOf ?? 'sleep 30';
    // 指纹从「这条命令」算：默认与台账一致；fingerprintOf 传别的命令即可制造漂移。
    const survival = computeLedgerArgsSurvival('Bash', { command });
    repo.insert({
      id: 'resume-1',
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
        requestedAt: input.requestedAt ?? 1_000,
        argsRef: { sessionId, toolCallId },
        argsFingerprint: survival.argsFingerprint,
        ledgerFaithful: true,
      },
      submittedAt: 1_000,
    });
  }

  it('批准：从台账执行一次，结果消息落回原会话（稳定 id），行收口 approved', async () => {
    seedSurvivorRow();

    const outcome = await resume('allow');

    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(sideEffectLog).toEqual(['echo >> sleep 30']);
    expect(repo.getById('resume-1')).toMatchObject({ status: 'approved', resolvedAt: now });
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toMatchObject({
      id: `resume-assistant:approved-tool-result:${toolCallId}`,
      role: 'tool',
    });
    expect(persistedMessages[0].toolResults?.[0]).toMatchObject({ toolCallId, success: true });
  });

  it('重启恢复点 allow_run（到这次做完为止）→ 按放行恢复执行，不当拒绝（rework r2）', async () => {
    seedSurvivorRow();

    const outcome = await resume('allow_run');

    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(sideEffectLog).toEqual(['echo >> sleep 30']);
    expect(repo.getById('resume-1')).toMatchObject({ status: 'approved', feedback: expect.not.stringContaining('rejected') });
  });

  it('重启恢复点 allow_24h（24 小时内允许）→ 按放行恢复执行，不当拒绝（rework r2）', async () => {
    seedSurvivorRow();

    const outcome = await resume('allow_24h');

    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executions).toBe(1);
    expect(repo.getById('resume-1')).toMatchObject({ status: 'approved', feedback: expect.not.stringContaining('rejected') });
  });

  it('重复批准：第二次点击行已非 pending → 不接手、不再执行（点击了也不执行第二次）', async () => {
    seedSurvivorRow();

    await resume('allow');
    const second = await resume('allow');

    expect(second).toEqual({ handled: false });
    expect(executions).toBe(1);
  });

  it('并发批准：两路同时进，认领 changes==1 者赢 → 只执行一次；输家 lost_race 不执行', async () => {
    seedSurvivorRow();
    const ports = buildPorts();

    // 工作目录解析（await，rework r1 起在认领前 fail-closed）让两路都进到认领门：
    // better-sqlite3 原子 UPDATE 保证 changes==1 者赢——赢家执行一次，输家 lost_race
    // 不执行（调用方按 handled:true 送达回报），两路加起来恰好执行一次。
    const [a, b] = await Promise.all([
      resumeSurvivingParkedApproval({ requestId: 'resume-1', response: 'allow', now, ports }),
      resumeSurvivingParkedApproval({ requestId: 'resume-1', response: 'allow', now, ports }),
    ]);
    const statuses = [a, b].map((outcome) => (outcome.handled ? outcome.status : 'not_candidate'));

    expect(statuses.filter((status) => status === 'executed')).toHaveLength(1);
    expect(statuses).toContain('lost_race');
    expect(executions).toBe(1);
  });

  it('拒绝：什么都不执行，行 rejected，台账落 denied 结果消息', async () => {
    seedSurvivorRow();

    const outcome = await resume('deny');

    expect(outcome).toMatchObject({ handled: true, status: 'denied' });
    expect(executions).toBe(0);
    expect(repo.getById('resume-1')).toMatchObject({ status: 'rejected', feedback: 'rejected by user after restart' });
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0].toolResults?.[0]).toMatchObject({
      toolCallId,
      success: false,
      error: 'approval rejected by user after restart',
    });
  });

  it('台账 args 漂移（停车指纹 ≠ 台账重算）→ args_unavailable，绝不执行', async () => {
    // 行里落的是另一条命令的指纹 = 「点的是 A、台账变出了 B」。
    seedSurvivorRow({ fingerprintOf: 'rm -rf /somewhere' });

    const outcome = await resume('allow');

    expect(outcome).toMatchObject({ handled: true, status: 'closed', reason: 'args_unavailable' });
    expect(executions).toBe(0);
    expect(repo.getById('resume-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable',
    });
  });

  it('台账已有该 toolCall 的结果 → 按不可存活收口（args_unavailable），绝不重放', async () => {
    seedSurvivorRow();
    messages = [...messages, {
      id: 'resume-tool-existing',
      role: 'tool',
      content: 'already done',
      timestamp: 3,
      toolResults: [{ toolCallId, success: true, output: 'already done' }],
    } as Message];

    const outcome = await resume('allow');

    expect(outcome).toMatchObject({ handled: true, status: 'closed', reason: 'args_unavailable' });
    expect(executions).toBe(0);
    expect(repo.getById('resume-1')?.status).toBe('rejected');
  });

  it('认领后、结果落盘前崩溃的形状（行已 approved）→ 再点不接手、永不重执行', async () => {
    seedSurvivorRow();
    repo.resolve({ id: 'resume-1', status: 'approved', feedback: 'approved after restart', resolvedAt: 4_000 });

    const outcome = await resume('allow');

    expect(outcome).toEqual({ handled: false });
    expect(executions).toBe(0);
  });

  it('认领输家（另一进程/并发投递已把行翻成 approved）→ 本路绝不执行', async () => {
    seedSurvivorRow();
    // 跨进程竞态的确定性等价物：本路读到的还是 pending，但认领 UPDATE 的 changes==0
    // （对方先翻走了行）。认领门必须挡在执行之前——否则两边各执行一次。
    const realResolve = repo.resolve.bind(repo);
    const racedRepo = {
      ...(repo as object),
      getById: repo.getById.bind(repo),
      resolve: (input: Parameters<PendingApprovalRepository['resolve']>[0]) => (
        input.status === 'approved' ? 0 : realResolve(input)
      ),
    } as unknown as typeof repo;
    const ports = { ...buildPorts(), repo: racedRepo };

    const outcome = await resumeSurvivingParkedApproval({ requestId: 'resume-1', response: 'allow', now, ports });

    expect(outcome).toEqual({ handled: true, status: 'lost_race' });
    expect(executions).toBe(0);
    expect(sideEffectLog).toEqual([]);
  });

  it('过期（24h 外到达的迟到点击）→ 非候选不接手，交回旧收口路径，什么都不执行', async () => {
    seedSurvivorRow({ requestedAt: 0 });
    const late = now + 25 * 3_600_000;

    const outcome = resumeSurvivingParkedApproval({
      requestId: 'resume-1', response: 'allow', now: late, ports: buildPorts(),
    });

    // 候选门先按龄拦截：过期行回 {handled:false}，调用方走 closeDeadParkedApproval 收口。
    await expect(outcome).resolves.toEqual({ handled: false });
    expect(executions).toBe(0);
    expect(repo.getById('resume-1')?.status).toBe('pending'); // 收口归调用方，resume 不越权
  });

  it('非候选行（无指纹的老行）→ 不接手，交回旧的 fail-closed 路径', async () => {
    repo.insert({
      id: 'resume-1',
      kind: 'tool_approval',
      agentId: null,
      agentName: null,
      coordinatorId: sessionId,
      payload: { sessionId, tool: 'Bash', requestedAt: 1_000 },
      submittedAt: 1_000,
    });

    const outcome = await resume('allow');

    expect(outcome).toEqual({ handled: false });
    expect(executions).toBe(0);
  });
});
