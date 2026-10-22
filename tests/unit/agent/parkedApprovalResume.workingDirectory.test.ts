// ============================================================================
// 停车审批重启批准的工作目录安全（rework r1，2026-10-22）
// ----------------------------------------------------------------------------
// 反例：会话工作目录解析失败（记录缺失 / 没落过 workingDirectory）时静默回退
// os.homedir()——批准的相对路径命令会以家目录为 cwd 执行，副作用落错目录。
// 判据：① 解析不出 → fail-closed 拒绝执行（args_unavailable），执行器绝不构造、
// 台账落 denied 结果；② 会话记录带 workingDirectory → 默认端口解析它作为执行 cwd。
// 走默认端口（不注入 ports）：databaseService / ToolExecutor 全 mock，真 SQLite 行。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import type { Message } from '../../../src/shared/contract';

const executorState = vi.hoisted(() => ({
  constructions: 0,
  configs: [] as Array<{ workingDirectory?: string }>,
  executions: 0,
}));
vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {
    constructor(config: { workingDirectory?: string }) {
      executorState.constructions += 1;
      executorState.configs.push(config);
    }
    async execute() {
      executorState.executions += 1;
      return { success: true, output: `mock-executed #${executorState.executions}` };
    }
  },
}));

let repoRef: PendingApprovalRepository | null = null;
let messagesRef: Message[] = [];
let persistedRef: Message[] = [];
let sessionRecordRef: { workingDirectory?: string } | null = null;
let currentDb: BetterSqlite3.Database | null = null;
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getPendingApprovalRepo: () => repoRef,
    getMessages: () => messagesRef,
    addMessage: (_sessionId: string, message: Message) => {
      persistedRef.push(message);
    },
    getSession: () => sessionRecordRef,
  }),
}));

import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';

describe('parked approval resume: session working directory must resolve or refuse', () => {
  const sessionId = 'resume-ws-session';
  const toolCallId = 'call-resume-ws';
  const now = 5_000;

  beforeEach(() => {
    const db: BetterSqlite3.Database = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY, kind TEXT, agent_id TEXT, agent_name TEXT, coordinator_id TEXT,
        payload_json TEXT, status TEXT, submitted_at INTEGER, resolved_at INTEGER, feedback TEXT
      );
    `);
    currentDb = db;
    repoRef = new PendingApprovalRepository(db);
    executorState.constructions = 0;
    executorState.configs = [];
    executorState.executions = 0;
    persistedRef = [];
    sessionRecordRef = null;
    messagesRef = [
      { id: 'resume-ws-user', role: 'user', content: 'run it', timestamp: 1 },
      {
        id: 'resume-ws-assistant',
        role: 'assistant',
        content: '',
        timestamp: 2,
        toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command: 'rm -rf ./build' } }],
      },
    ];

    const survival = computeLedgerArgsSurvival('Bash', { command: 'rm -rf ./build' });
    repoRef.insert({
      id: 'resume-ws-1',
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
        requestedAt: 1_000,
        argsRef: { sessionId, toolCallId },
        argsFingerprint: survival.argsFingerprint,
        ledgerFaithful: true,
      },
      submittedAt: 1_000,
    });
  });

  afterEach(() => currentDb?.close());

  const resumeDefaultPorts = () =>
    resumeSurvivingParkedApproval({ requestId: 'resume-ws-1', response: 'allow', now });

  it('会话记录缺失（owner-scoped 查询错 miss 的形状）→ 拒绝执行，绝不以家目录为 cwd 构造执行器', async () => {
    sessionRecordRef = null;

    const outcome = await resumeDefaultPorts();

    expect(outcome).toMatchObject({ handled: true, status: 'closed', reason: 'args_unavailable' });
    expect(executorState.constructions).toBe(0);
    expect(executorState.executions).toBe(0);
    expect(repoRef?.getById('resume-ws-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable',
    });
    expect(persistedRef).toHaveLength(1);
    expect(persistedRef[0].toolResults?.[0]).toMatchObject({
      toolCallId,
      success: false,
      error: expect.stringContaining('session working directory unavailable after restart'),
    });
  });

  it('会话在但没落过 workingDirectory → 同样拒绝执行（不回退家目录）', async () => {
    sessionRecordRef = { workingDirectory: undefined };

    const outcome = await resumeDefaultPorts();

    expect(outcome).toMatchObject({ handled: true, status: 'closed', reason: 'args_unavailable' });
    expect(executorState.constructions).toBe(0);
    expect(executorState.executions).toBe(0);
    expect(repoRef?.getById('resume-ws-1')?.status).toBe('rejected');
  });

  it('会话带 workingDirectory → 默认端口解析它作为执行 cwd，执行一次', async () => {
    sessionRecordRef = { workingDirectory: '/srv/parked-ws' };

    const outcome = await resumeDefaultPorts();

    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executorState.executions).toBe(1);
    expect(executorState.configs[0]?.workingDirectory).toBe('/srv/parked-ws');
    expect(repoRef?.getById('resume-ws-1')?.status).toBe('approved');
    expect(persistedRef).toHaveLength(1);
    expect(persistedRef[0].toolResults?.[0]).toMatchObject({ toolCallId, success: true });
  });
});
