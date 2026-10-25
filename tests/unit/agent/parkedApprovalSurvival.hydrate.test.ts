// ============================================================================
// 停车审批跨重启存活：启动链判据（N-PARKED-APPROVAL-SURVIVE-RESTART-RESUME ①②）
// ----------------------------------------------------------------------------
// 真实 SQLite（pending_approvals + sessions/messages 全 schema）+ 假时钟：
//   ① 23h59m 的幸存行保持 pending、标题「重启前发起 · <tool>」、触发 durable 停靠；
//      24h01m → rejected(expired_after_restart_24h)；参数不可恢复 → rejected(args_unavailable)；
//      directory_access / channel_pairing 照旧全拒。
//   ② startupMaintenance 的 orphan-toolcall-closure 不给幸存 toolCall 写 INTERRUPTED 占位
//      （不毒化 toolCallId），非幸存的照写。
//   ③（N-...-RESUME-FU1）会话 cwd 解析不出的行（无来源会话的 cron 任务形状）在
//      maintenance + hydrate 两次判定里都不存活：行收口 args_unavailable 的可区分后缀、
//      toolCall 写 INTERRUPTED 占位；带 cwd 的会话照常幸存。收件箱不再出现点了必被拒的死卡。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
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
import type { createLogger } from '../../../src/host/services/infra/logger';
import type { Message, Session } from '../../../src/shared/contract';
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';
import { resumeSurvivingParkedApproval } from '../../../src/host/agent/parkedApprovalResume';
import type { ParkedApprovalResumePorts } from '../../../src/host/agent/parkedApprovalResume';

const planAttach = vi.fn(() => 0);
const launchAttach = vi.fn(() => 0);
vi.mock('../../../src/host/agent/planApproval', () => ({
  getPlanApprovalGate: () => ({ attachPersistence: planAttach }),
}));
vi.mock('../../../src/host/agent/swarmLaunchApproval', () => ({
  getSwarmLaunchApprovalGate: () => ({ attachPersistence: launchAttach }),
}));

// FU1：hydrate 的缺省 cwd 解析走 getDatabase().getSession（与点击恢复同口径），这里把单例
// 指到本文件的真实内存库——缺省依赖被真实执行而非绕过；收件箱读径
// （sessionAutomationService.listParkedApprovals）同样经 getDatabase().getPendingApprovalRepo 取数。
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
// listParkedApprovals 所在模块经 ../../platform 广播；收件箱读径只用它的取数口，广播替身即可。
vi.mock('../../../src/host/platform', () => ({ broadcastToRenderer: vi.fn() }));

import { hydrateApprovalGatesAtBoot } from '../../../src/host/agent/parkedApprovalHydration';

const INTERRUPTED_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';

/** 与生产停车链同一口径的 payload 原料：executor 参数 → 账本形指纹 + 忠实标记。 */
function bashSurvivalPayload(command: string): {
  argsFingerprint: string;
  ledgerFaithful: boolean;
} {
  return computeLedgerArgsSurvival('Bash', { command });
}

describe('parked approval survival across restart (hydrate + startupMaintenance)', () => {
  let db: BetterSqlite3.Database;
  let sessionRepo: SessionRepository;
  let repo: PendingApprovalRepository;
  let logger: ReturnType<typeof createLogger>;
  let parkedRuns: Array<{ runId: string; status: string; interruptCause?: string }>;
  const loadSessionMessages = (sessionId: string): Message[] | null => {
    try {
      return sessionRepo.getMessages(sessionId);
    } catch {
      return null;
    }
  };
  // 停靠口替身：真实 parkSessionDurableRunsForApproval 会拿它走完整路径，
  // 这里记录 replaceRecoveryProjection 的调用形状即可断言「幸存行触发了 guard_halt 停靠」。
  const durableRunRepoStub = {
    listActiveRunRoster: async () => [
      { runId: 'run-survivor', sessionId: 'survivor-session', status: 'running', ownerId: 'owner-1' },
      { runId: 'run-chain-survivor', sessionId: 'chain-survivor', status: 'running', ownerId: 'owner-2' },
    ],
    get: async (runId: string) => ({
      runId, attempt: 1, autoResumeCount: 0, owner: { epoch: 0, ownerId: 'owner', processInstanceId: 'p', leaseExpiresAt: 0 },
    }),
    listPendingOperations: async () => [],
    replaceRecoveryProjection: async (input: { runId: string; status: string; interruptCause?: string }) => {
      parkedRuns.push(input);
      return {};
    },
  } as unknown as import('../../../src/host/services/core/repositories/DurableRunRepository').DurableRunRepository;
  const hydrate = (now: number) => hydrateApprovalGatesAtBoot(repo, now, {
    loadSessionMessages,
    durableRunRepository: durableRunRepoStub,
  });

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as unknown as ReturnType<typeof createLogger>;
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    sessionRepo = new SessionRepository(db);
    repo = new PendingApprovalRepository(db);
    dbState.sessionRepo = sessionRepo;
    dbState.repo = repo;
    parkedRuns = [];
    vi.clearAllMocks();
  });
  afterEach(() => db.close());

  /** 缺省带 cwd（幸存前提，FU1 ④）；传 null 复刻无来源会话的 cron 任务形状（workingDirectory NULL）。 */
  function createCrashedSession(id: string, workingDirectory: string | null = `/workspace/${id}`): void {
    sessionRepo.createSession({
      id,
      title: id,
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      ...(workingDirectory ? { workingDirectory } : {}),
      createdAt: 1,
      updatedAt: 1,
      status: 'running',
    } as Session);
  }

  function seedAssistantToolCall(sessionId: string, toolCallId: string, command: string): void {
    sessionRepo.addMessage(sessionId, {
      id: `${sessionId}-assistant`,
      role: 'assistant',
      content: '',
      timestamp: 10,
      toolCalls: [{ id: toolCallId, name: 'Bash', arguments: { command } }],
    } as Message);
  }

  function seedParkedRow(input: {
    id: string;
    sessionId: string;
    toolCallId: string;
    requestedAt: number;
    command?: string;
    faithful?: boolean;
    withFingerprint?: boolean;
    kind?: 'tool_approval' | 'directory_access' | 'channel_pairing';
  }): void {
    const command = input.command ?? 'sleep 30';
    const survival = bashSurvivalPayload(command);
    const withFingerprint = input.withFingerprint ?? true;
    const faithful = input.faithful ?? true;
    repo.insert({
      id: input.id,
      kind: input.kind ?? 'tool_approval',
      agentId: null,
      agentName: null,
      coordinatorId: input.sessionId,
      payload: {
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        tool: 'Bash',
        type: 'command',
        permissionLevel: 'medium',
        requestedAt: input.requestedAt,
        argsRef: { sessionId: input.sessionId, toolCallId: input.toolCallId },
        ...(withFingerprint ? { argsFingerprint: survival.argsFingerprint, ledgerFaithful: faithful } : {}),
      },
      submittedAt: input.requestedAt,
    });
  }

  it('① 23h59m：幸存行保持 pending、标记「重启前发起」、触发该会话 durable 停靠；同批不可恢复行按 args_unavailable 收口', async () => {
    createCrashedSession('survivor-session');
    seedAssistantToolCall('survivor-session', 'call-survivor', 'sleep 30');
    seedParkedRow({ id: 'survivor-1', sessionId: 'survivor-session', toolCallId: 'call-survivor', requestedAt: 1_000 });

    createCrashedSession('stale-session');
    seedAssistantToolCall('stale-session', 'call-stale', 'sleep 31');
    // 无指纹（老行 / executor 没算出原料）→ 不可恢复
    seedParkedRow({ id: 'stale-1', sessionId: 'stale-session', toolCallId: 'call-stale', requestedAt: 1_000, withFingerprint: false });

    const now = 1_000 + 23 * 3_600_000 + 59 * 60_000; // 23h59m
    const counts = hydrate(now);

    expect(counts.survived).toBe(1);
    expect(counts.parked).toBe(1);
    expect(repo.getById('survivor-1')).toMatchObject({ status: 'pending', resolvedAt: null });
    expect(JSON.parse(repo.getById('survivor-1')!.payloadJson).displayTool).toBe('重启前发起 · Bash');
    await new Promise((resolve) => setImmediate(resolve)); // 停靠写是 fire-and-forget 微任务
    expect(parkedRuns.map((run) => [run.runId, run.interruptCause])).toEqual([['run-survivor', 'guard_halt']]);
    expect(repo.getById('stale-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable',
      resolvedAt: now,
    });
  });

  it('① 24h01m：过期行按 expired_after_restart_24h 收口，不触发 durable 停靠', () => {
    createCrashedSession('expired-session');
    seedAssistantToolCall('expired-session', 'call-expired', 'sleep 30');
    seedParkedRow({ id: 'expired-1', sessionId: 'expired-session', toolCallId: 'call-expired', requestedAt: 1_000 });

    const now = 1_000 + 24 * 3_600_000 + 60_000; // 24h01m
    const counts = hydrate(now);

    expect(counts.survived).toBe(0);
    expect(repo.getById('expired-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: expired_after_restart_24h',
      resolvedAt: now,
    });
    expect(parkedRuns).toEqual([]);
  });

  it('① 账本形不忠实（ledgerFaithful=false，如 Write 大文本截断）→ args_unavailable，不存活', () => {
    createCrashedSession('unfaithful-session');
    seedAssistantToolCall('unfaithful-session', 'call-unfaithful', 'sleep 30');
    seedParkedRow({
      id: 'unfaithful-1', sessionId: 'unfaithful-session', toolCallId: 'call-unfaithful',
      requestedAt: 1_000, faithful: false,
    });

    const counts = hydrate(2_000);

    expect(counts.survived).toBe(0);
    expect(repo.getById('unfaithful-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable',
    });
  });

  it('① 台账缺承载消息（argsRef 指向不存在的 toolCall）→ args_unavailable', () => {
    createCrashedSession('missing-session');
    seedAssistantToolCall('missing-session', 'call-other', 'sleep 30');
    seedParkedRow({ id: 'missing-1', sessionId: 'missing-session', toolCallId: 'call-missing', requestedAt: 1_000 });

    const counts = hydrate(2_000);

    expect(counts.survived).toBe(0);
    expect(repo.getById('missing-1')?.status).toBe('rejected');
    expect(repo.getById('missing-1')?.feedback).toBe('Auto-rejected after restart: args_unavailable');
  });

  it('① 台账已有该 toolCall 的结果 → 不存活（不许二次执行的口子不从 hydrate 开）', () => {
    createCrashedSession('settled-session');
    seedAssistantToolCall('settled-session', 'call-settled', 'sleep 30');
    sessionRepo.addMessage('settled-session', {
      id: 'settled-tool',
      role: 'tool',
      content: 'done',
      timestamp: 11,
      toolResults: [{ toolCallId: 'call-settled', success: true, output: 'done' }],
    } as Message);
    seedParkedRow({ id: 'settled-1', sessionId: 'settled-session', toolCallId: 'call-settled', requestedAt: 1_000 });

    const counts = hydrate(2_000);

    expect(counts.survived).toBe(0);
    expect(repo.getById('settled-1')?.status).toBe('rejected');
  });

  it('① directory_access 与 channel_pairing 照旧 fail-closed 全拒（不因幸存机制放行）', () => {
    seedParkedRow({
      id: 'dir-1', sessionId: 'dir-session', toolCallId: 'call-dir',
      requestedAt: 1_000, kind: 'directory_access',
    });
    seedParkedRow({
      id: 'pairing-1', sessionId: 'pairing-session', toolCallId: 'call-pairing',
      requestedAt: 1_000, kind: 'channel_pairing',
    });

    const counts = hydrate(2_000);

    expect(counts.survived).toBe(0);
    expect(repo.getById('dir-1')).toMatchObject({
      status: 'rejected',
      feedback: expect.stringContaining('Auto-rejected after process restart'),
    });
    expect(repo.getById('pairing-1')?.status).toBe('rejected');
    expect(parkedRuns).toEqual([]);
  });

  it('② startupMaintenance 不给幸存 toolCall 写 INTERRUPTED 占位；非幸存的照写（链条不被毒化）', () => {
    // startupMaintenance 内部用真实 Date.now() 判龄，种子行就落在「现在」附近；
    // ① 的 23h59m/24h01m 边界由 hydrate 的假时钟参数单独钉。
    const fresh = Date.now() - 1_000;
    createCrashedSession('chain-survivor');
    seedAssistantToolCall('chain-survivor', 'call-chain-survivor', 'sleep 30');
    seedParkedRow({
      id: 'chain-survivor-1', sessionId: 'chain-survivor', toolCallId: 'call-chain-survivor', requestedAt: fresh,
    });

    createCrashedSession('chain-victim');
    seedAssistantToolCall('chain-victim', 'call-chain-victim', 'sleep 31');
    seedParkedRow({
      id: 'chain-victim-1', sessionId: 'chain-victim', toolCallId: 'call-chain-victim',
      requestedAt: fresh, withFingerprint: false,
    });

    // 模拟重启：先清算（带 pendingApprovalRepo），再 hydrate——与 webServer 真实启动序一致。
    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo: new ToolExecutionEventRepository(db),
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      pendingApprovalRepo: repo,
      logger,
      step: vi.fn(),
    });
    const counts = hydrate(2_000);

    const survivorMessages = sessionRepo.getMessages('chain-survivor');
    expect(survivorMessages).toHaveLength(1); // 只有 assistant，无占位 tool 消息
    expect(survivorMessages[0].role).toBe('assistant');
    const victimMessages = sessionRepo.getMessages('chain-victim');
    expect(victimMessages).toHaveLength(2);
    expect(victimMessages[1]).toMatchObject({
      id: 'chain-victim-assistant:interrupted-tool-results',
      role: 'tool',
      toolResults: [{ toolCallId: 'call-chain-victim', error: INTERRUPTED_PLACEHOLDER }],
    });
    // 清算没毒化幸存行：hydrate 后它仍 pending 可批准
    expect(counts.survived).toBe(1);
    expect(repo.getById('chain-survivor-1')?.status).toBe('pending');
  });

  it('② 缺 pendingApprovalRepo（旧装配/降级）时清算行为不变：全部写占位', () => {
    createCrashedSession('legacy-session');
    seedAssistantToolCall('legacy-session', 'call-legacy', 'sleep 30');
    seedParkedRow({ id: 'legacy-1', sessionId: 'legacy-session', toolCallId: 'call-legacy', requestedAt: 1_000 });

    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo: new ToolExecutionEventRepository(db),
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      logger,
      step: vi.fn(),
    });

    expect(sessionRepo.getMessages('legacy-session')).toHaveLength(2);
    expect(sessionRepo.getMessages('legacy-session')[1].toolResults?.[0]?.error).toBe(INTERRUPTED_PLACEHOLDER);
  });

  // ------------------------------------------------------------------
  // ③（N-...-RESUME-FU1）会话 cwd 解析不出的行（无来源会话的 cron 任务形状）
  // ------------------------------------------------------------------

  it('③ cwd-less 会话：maintenance 写 INTERRUPTED 占位 + hydrate 以可区分后缀收口；带 cwd 会话照常幸存', () => {
    const fresh = Date.now() - 1_000;
    createCrashedSession('cron-cwdless', null); // workingDirectory NULL（cron agent 任务无来源会话）
    seedAssistantToolCall('cron-cwdless', 'call-cwdless', 'sleep 30');
    seedParkedRow({ id: 'cwdless-1', sessionId: 'cron-cwdless', toolCallId: 'call-cwdless', requestedAt: fresh });

    createCrashedSession('cwd-session');
    seedAssistantToolCall('cwd-session', 'call-cwd', 'sleep 31');
    seedParkedRow({ id: 'cwd-1', sessionId: 'cwd-session', toolCallId: 'call-cwd', requestedAt: fresh });

    // 重启序：先 maintenance（同一次判据决定占位）再 hydrate（决定行收口）——与 webServer 启动一致。
    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo: new ToolExecutionEventRepository(db),
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      pendingApprovalRepo: repo,
      logger,
      step: vi.fn(),
    });
    const counts = hydrate(Date.now());

    expect(repo.getById('cwdless-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable (session working directory unavailable)',
    });
    // 它的 toolCall 不悬空：占位照写（maintenance 与 hydrate 同一判据的另一半）
    const cwdlessMessages = sessionRepo.getMessages('cron-cwdless');
    expect(cwdlessMessages).toHaveLength(2);
    expect(cwdlessMessages[1]).toMatchObject({
      id: 'cron-cwdless-assistant:interrupted-tool-results',
      role: 'tool',
      toolResults: [{ toolCallId: 'call-cwdless', error: INTERRUPTED_PLACEHOLDER }],
    });
    // 带 cwd 会话：占位不写、行幸存可批
    expect(sessionRepo.getMessages('cwd-session')).toHaveLength(1);
    expect(counts.survived).toBe(1);
    expect(repo.getById('cwd-1')?.status).toBe('pending');
  });

  it('③ 直接 hydrate（台账无占位）也收口 cwd-less 行——只拆掉 hydrate 侧 cwd 接线的变异会被这条咬红', () => {
    createCrashedSession('cron-direct', null);
    seedAssistantToolCall('cron-direct', 'call-direct', 'sleep 30');
    seedParkedRow({ id: 'direct-1', sessionId: 'cron-direct', toolCallId: 'call-direct', requestedAt: 1_000 });

    const counts = hydrate(2_000);

    expect(counts.survived).toBe(0);
    expect(repo.getById('direct-1')).toMatchObject({
      status: 'rejected',
      feedback: 'Auto-rejected after restart: args_unavailable (session working directory unavailable)',
    });
  });

  // ⑥（N-...-RESUME-FU1）真实 SQLite 重启仿真：maintenance → hydrate → 收件箱读径 → 批准执行一次。
  it('③⑥ 收件箱读径只列带 cwd 会话的幸存卡；批准它恰执行一次，再点不重复', async () => {
    const fresh = Date.now() - 1_000;
    createCrashedSession('inbox-cwdless', null);
    seedAssistantToolCall('inbox-cwdless', 'call-inbox-cwdless', 'sleep 30');
    seedParkedRow({ id: 'inbox-cwdless-1', sessionId: 'inbox-cwdless', toolCallId: 'call-inbox-cwdless', requestedAt: fresh });

    createCrashedSession('inbox-cwd');
    seedAssistantToolCall('inbox-cwd', 'call-inbox-cwd', 'echo once >> effect.txt');
    seedParkedRow({
      id: 'inbox-cwd-1', sessionId: 'inbox-cwd', toolCallId: 'call-inbox-cwd',
      requestedAt: fresh, command: 'echo once >> effect.txt',
    });

    runStartupMaintenance({
      db,
      sessionRepo,
      memoryRepo: new MemoryRepository(db),
      toolExecutionEventRepo: new ToolExecutionEventRepository(db),
      permissionDecisionRepo: new PermissionDecisionRepository(db),
      pendingApprovalRepo: repo,
      logger,
      step: vi.fn(),
    });
    hydrate(Date.now());

    // 收件箱读径（sessionAutomationService.listParkedApprovals）：cwd-less 卡不再出现
    const { SessionAutomationService } = await import('../../../src/host/services/sessionAutomation/sessionAutomationService');
    const inbox = new SessionAutomationService().listParkedApprovals();
    expect(inbox.map((item) => item.id)).toEqual(['inbox-cwd-1']);
    expect(inbox[0]).toMatchObject({ sessionId: 'inbox-cwd', tool: 'Bash', status: 'pending' });

    // 批准收件箱里那张卡：从台账执行一次，cwd 用会话工作目录；再点不再执行
    const executed: Array<{ name: string; workingDirectory: string; command: string }> = [];
    const ports: ParkedApprovalResumePorts = {
      repo,
      loadMessages: (sessionId) => sessionRepo.getMessages(sessionId),
      resolveWorkingDirectory: (sessionId) => sessionRepo.getSession(sessionId)?.workingDirectory || null,
      executeTool: async (input) => {
        executed.push({
          name: input.name,
          workingDirectory: input.workingDirectory,
          command: String(input.arguments.command),
        });
        return { success: true, output: 'ran once' };
      },
      persistToolMessage: async (sessionId, message) => {
        sessionRepo.addMessage(sessionId, message);
      },
      now: () => Date.now(),
    };
    const outcome = await resumeSurvivingParkedApproval({ requestId: 'inbox-cwd-1', response: 'allow', ports });
    expect(outcome).toMatchObject({ handled: true, status: 'executed' });
    expect(executed).toEqual([{ name: 'Bash', workingDirectory: '/workspace/inbox-cwd', command: 'echo once >> effect.txt' }]);
    expect(repo.getById('inbox-cwd-1')?.status).toBe('approved');
    // 结果落回原会话转录（打开原会话能看到执行结果）
    expect(sessionRepo.getMessages('inbox-cwd').some((message) => (
      message.role === 'tool'
      && message.toolResults?.some((result) => result.toolCallId === 'call-inbox-cwd' && result.success)
    ))).toBe(true);
    // 第二次点击：行已非 pending → 不接手、不重复执行
    const again = await resumeSurvivingParkedApproval({ requestId: 'inbox-cwd-1', response: 'allow', ports });
    expect(again).toEqual({ handled: false });
    expect(executed).toHaveLength(1);
  });
});
