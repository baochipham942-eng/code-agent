// ============================================================================
// workflow 终态 settlement claim 的跨重启去重（N-WF-SETTLEMENT-DEDUPE / 设计 D6-A）
// ============================================================================
// 钉死的事实：claimWorkflowSettlement 的进程内 Set 重启即空，同 runId 同终态在第
// 二个进程里再 settle 时必须被 workflow_settlement_claims 的 durable 键挡住——
// 「workflow finished/failed」终态宣布（onClaimed → 恢复提案/completing 进度）
// 跨重启至多一次。
//
// 重启夹具（任务书 ③）：vi.resetModules() 清空模块级 Set 与注册表单例，同一
// sqlite 文件先 close 再重开（新 Database 句柄 + 生产 applySchema 幂等重跑），
// real better-sqlite3（vi.unmock，同 WorkflowJournalRepository.test.ts）。
// 断言的「通知」与既有 in-process 去重测试（workflow.test.ts 的 dup 用例）同口径：
// onClaimed 驱动的 recordLongTaskRecoveryProposal（failed 终态的恢复提案）次数。
// 注册表自己的 completion 队列（queuedNotificationKeys）是另一套机制，本单明确
// 不动：branch-1 adopt 的 completion record 仍会入队，这里如实断言为 1 条。
// ============================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';
import type { ScriptRunSpec, ScriptRunState, ScriptRunHostDeps } from '../../../../../src/host/agent/scriptRuntime';
// 生产 applySchema：顺带钉「新表在真 schema 里存在 + 二次应用是 no-op」。
import { applyTestSessionSchema } from '../../../../utils/applyTestSessionSchema';

// ── 与 workflow.test.ts 同款的 mock 栈：startRun 可控终态、审批默认放行 ──────────
const startRunMock = vi.fn();
vi.mock('../../../../../src/host/agent/scriptRuntime', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/scriptRuntime')>();
  return { ...actual, startRun: (spec: ScriptRunSpec, deps: ScriptRunHostDeps) => startRunMock(spec, deps) };
});

const resolveSessionDefaultMock = vi.fn();
vi.mock('../../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: (args: unknown) => resolveSessionDefaultMock(args),
}));

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock('../../../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => ({ publish: publishMock }),
}));

const { approvalHolder, idleWakeMock, recordRecoveryMock, uuidOverride, journalHolder } = vi.hoisted(() => ({
  approvalHolder: { approved: true },
  idleWakeMock: vi.fn(),
  recordRecoveryMock: vi.fn(),
  uuidOverride: { value: null as string | null },
  journalHolder: {
    repo: null as null | import('../../../../../src/host/services/core/repositories/WorkflowJournalRepository').WorkflowJournalRepository,
  },
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => uuidOverride.value ?? actual.randomUUID(),
  };
});
vi.mock('../../../../../src/host/agent/backgroundSubagentIdleWake', () => ({
  scheduleBackgroundSubagentIdleWake: (record: unknown) => idleWakeMock(record),
}));

vi.mock('../../../../../src/host/handoff/longTaskRecoveryProposal', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/handoff/longTaskRecoveryProposal')>();
  return {
    ...actual,
    recordLongTaskRecoveryProposal: (input: Parameters<typeof actual.recordLongTaskRecoveryProposal>[0]) => {
      recordRecoveryMock(input);
      return actual.recordLongTaskRecoveryProposal(input);
    },
  };
});

vi.mock('../../../../../src/host/agent/workflowLaunchApproval', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/agent/workflowLaunchApproval')>();
  return {
    ...actual,
    getWorkflowLaunchApprovalGate: () => ({
      requestApproval: async ({ request }: { request: unknown }) => ({
        approved: approvalHolder.approved,
        autoApproved: true,
        feedback: approvalHolder.approved ? undefined : '用户拒绝',
        request,
      }),
    }),
  };
});

// ── 本单特有的接线：访问器指向真实 repo（真实 better-sqlite3 文件库）──────────────
// mock 只覆写 getWorkflowJournalRepository，类本体来自 actual——夹具直接 new。
vi.mock('../../../../../src/host/services/core/repositories/WorkflowJournalRepository', async (orig) => {
  const actual = await orig<typeof import('../../../../../src/host/services/core/repositories/WorkflowJournalRepository')>();
  return {
    ...actual,
    getWorkflowJournalRepository: () => journalHolder.repo,
  };
});

import { WorkflowJournalRepository } from '../../../../../src/host/services/core/repositories/WorkflowJournalRepository';

type WorkflowModule = typeof import('../../../../../src/host/tools/modules/multiagent/workflow');
type RegistryModule = typeof import('../../../../../src/host/agent/backgroundSubagentRegistry');
type WorkflowHandler = Awaited<ReturnType<WorkflowModule['workflowModule']['createHandler']>>;
type BackgroundRegistry = ReturnType<RegistryModule['getBackgroundSubagentRegistry']>;

const WORKFLOW_MODULE = '../../../../../src/host/tools/modules/multiagent/workflow';
const REGISTRY_MODULE = '../../../../../src/host/agent/backgroundSubagentRegistry';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const BASE_MODEL = { provider: 'xiaomi', model: 'mimo-v2.5-pro', apiKey: 'base-key', baseUrl: 'https://base' };
const allowAll: CanUseToolFn = async () => ({ allow: true });

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'sess-restart',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    modelConfig: { ...BASE_MODEL },
    resolver: { list: () => [], has: () => false, getDefinition: () => undefined, listDefinitions: () => [], execute: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

function failedState(error = 'bad'): ScriptRunState {
  return { runId: 'x', status: 'failed', scriptHash: 'h', startedAt: 0, agentCallCount: 1, tokensSpent: 0, cacheHits: 0, phases: ['p'], error, result: undefined };
}

/** 一个「进程」：fresh 模块实例（fresh Set + fresh 注册表单例）+ 重开同一 sqlite 文件的 repo。 */
async function bootProcess(db: BetterSqlite3.Database) {
  journalHolder.repo = new WorkflowJournalRepository(db);
  const workflow = (await import(WORKFLOW_MODULE)) as WorkflowModule;
  const { getBackgroundSubagentRegistry } = (await import(REGISTRY_MODULE)) as RegistryModule;
  const handler = await workflow.workflowModule.createHandler();
  return { workflow, registry: getBackgroundSubagentRegistry(), handler };
}

async function launchAndSettle(
  handler: WorkflowHandler,
  registry: BackgroundRegistry,
  currentToolCallId: string,
): Promise<string> {
  const result = await handler.execute(
    { script: 'return 1' },
    makeCtx({ currentToolCallId }),
    allowAll,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const runId = result.meta?.runId;
  if (typeof runId !== 'string') throw new Error('missing background runId');
  await vi.waitFor(() => {
    const status = registry.getStatus(runId)?.status;
    expect(status === 'completed' || status === 'failed').toBe(true);
  });
  await registry.await(runId);
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
  return runId;
}

describe('workflow settlement claim across a simulated process restart', () => {
  let dir: string;
  let dbPath: string;
  const openDbs: BetterSqlite3.Database[] = [];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'wf-settlement-restart-'));
    dbPath = path.join(dir, 'claims.db');
    startRunMock.mockReset();
    resolveSessionDefaultMock.mockReset();
    publishMock.mockReset();
    idleWakeMock.mockReset();
    recordRecoveryMock.mockReset();
    uuidOverride.value = null;
    approvalHolder.approved = true;
    journalHolder.repo = null;
    startRunMock.mockResolvedValue(failedState());
  });

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.resetModules();
  });

  function openProcessDb(): BetterSqlite3.Database {
    const db = new Database(dbPath);
    applyTestSessionSchema(db);
    openDbs.push(db);
    return db;
  }

  it('announces the same (runId, terminalStatus) only once across a restart', async () => {
    // ── 进程 1：run settle 成 failed，宣布一次，durable claim 落行 ──
    uuidOverride.value = 'deadbeef-1111-2222-3333-444444444444';
    const db1 = openProcessDb();
    const p1 = await bootProcess(db1);
    const runId = await launchAndSettle(p1.handler, p1.registry, 'restart-call');
    expect(runId).toBe('wf-restart-call-deadbeef');

    expect(recordRecoveryMock).toHaveBeenCalledTimes(1);
    const drained1 = p1.registry.drainCompletionNotifications({ sessionId: 'sess-restart' });
    expect(drained1).toHaveLength(1);
    const claimRow = db1.prepare(
      'SELECT COUNT(*) as c FROM workflow_settlement_claims WHERE run_id = ? AND terminal_status = ?',
    ).get(runId, 'failed') as { c: number };
    expect(claimRow.c).toBe(1);

    // ── 重启：模块级 Set 与注册表单例随 resetModules 蒸发；sqlite 文件 close 后重开 ──
    db1.close();
    openDbs.splice(openDbs.indexOf(db1), 1);
    vi.resetModules();
    const db2 = openProcessDb();

    // ── 进程 2：同 currentToolCallId + 同 uuid → 同 runId 再次 settle 同终态 ──
    const p2 = await bootProcess(db2);
    const rerunId = await launchAndSettle(p2.handler, p2.registry, 'restart-call');
    expect(rerunId).toBe(runId);

    // durable claim 挡住第二次终态宣布：恢复提案仍只有进程 1 的那一条。
    expect(recordRecoveryMock).toHaveBeenCalledTimes(1);
    // 注册表自己的 completion 队列是另一套机制（本单不动）：branch-1 的 record 仍入队，
    // 如实断言 1 条——去重信号是上面的宣布次数，不是这里的队列长度。
    const drained2 = p2.registry.drainCompletionNotifications({ sessionId: 'sess-restart' });
    expect(drained2).toHaveLength(1);
  });

  it('a rerun whose previous process never settled still announces exactly once (no stale claim)', async () => {
    uuidOverride.value = 'cafef00d-1111-2222-3333-444444444444';
    // ── 进程 1：run 起飞后进程死在 settlement 之前——claim 只在 settle 时写，此刻无行 ──
    const neverSettles = new Promise<ScriptRunState>(() => {});
    startRunMock.mockReturnValue(neverSettles);
    const db1 = openProcessDb();
    const p1 = await bootProcess(db1);
    const first = await p1.handler.execute(
      { script: 'return 1' },
      makeCtx({ currentToolCallId: 'died-mid-run' }),
      allowAll,
    );
    expect(first.ok).toBe(true);
    await vi.waitFor(() => expect(startRunMock).toHaveBeenCalledTimes(1));
    const claimBefore = db1.prepare('SELECT COUNT(*) as c FROM workflow_settlement_claims').get() as { c: number };
    expect(claimBefore.c).toBe(0);

    db1.close();
    openDbs.splice(openDbs.indexOf(db1), 1);
    vi.resetModules();
    const db2 = openProcessDb();

    // ── 进程 2：同 runId 重跑并真正 settle——宣布恰好一次，不被不存在的旧 claim 吞掉 ──
    startRunMock.mockResolvedValue(failedState('rerun failure'));
    const p2 = await bootProcess(db2);
    const runId = await launchAndSettle(p2.handler, p2.registry, 'died-mid-run');
    expect(runId).toBe('wf-died-mid-run-cafef00d');
    expect(recordRecoveryMock).toHaveBeenCalledTimes(1);
    const drained = p2.registry.drainCompletionNotifications({ sessionId: 'sess-restart' });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.content).toContain(runId);
    const claimAfter = db2.prepare(
      'SELECT COUNT(*) as c FROM workflow_settlement_claims WHERE run_id = ?',
    ).get(runId) as { c: number };
    expect(claimAfter.c).toBe(1);
  });
});
