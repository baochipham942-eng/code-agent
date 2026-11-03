// ============================================================================
// N-PERM-NL-RULES-K2 — handback（交回我亲手做）全链路 + K1 ask 运行时强制弹审批
// ----------------------------------------------------------------------------
// ② 真 ToolExecutor + 真 OrchestratorPermissionIsland + 内存版 pending-approval
//    repo：无人值守会话命中 handback 规则 → 工具不执行、停车行带 handback 标记、
//    notifyNeedsInput 用 handback 专属文案、不进失败态；两个按钮（我做完了 /
//    让 Neo 做这一次）分别收口。① K1 旧表 ask 规则在真执行器上强制弹审批
//    （已知安全命令与分类器 auto-approve 都要让路）。④ preapprove 命中免卡、
//    未命中出卡。
// 工具派发边界（toolResolver.execute）mock 掉：验证的是审批链，不是工具本身。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ callTool: vi.fn(), getTools: () => [] }),
}));

const notifyCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: {
    notifyNeedsInput: vi.fn((input: Record<string, unknown>) => {
      notifyCalls.push(input);
    }),
  },
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ToolExecutionResult } from '../../../src/host/tools/types';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { beginRunPolicy, endRunPolicy } from '../../../src/host/permissions/runPolicySnapshot';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import type { PendingApprovalKind, PendingApprovalStatus, ToolApprovalPayload } from '../../../src/shared/contract/pendingApproval';
import type { AppSettings } from '../../../src/shared/contract';
import { NL_RULE_K2_TEXT } from '../../../src/shared/nlRuleRestate';

/** 外部副作用工具（转账/改密码一类）：requiresPermission，走完整审批链。 */
const TRANSFER_TOOL = 'mcp__bank__transfer';

function transferDefinition() {
  return {
    name: TRANSFER_TOOL,
    description: 'bank transfer',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true,
    permissionLevel: 'execute' as const,
    readOnly: false,
  };
}

/** 内存版 pending-approval repo（②）：insert/resolve 真记账，可断言行内容。 */
interface MemoryRow {
  id: string;
  kind: PendingApprovalKind;
  payload: ToolApprovalPayload;
  status: PendingApprovalStatus;
  feedback: string | null;
}
function makeMemoryRepo() {
  const rows = new Map<string, MemoryRow>();
  const repo = {
    insert: (input: { id: string; kind: PendingApprovalKind; payload: unknown }) => {
      rows.set(input.id, {
        id: input.id,
        kind: input.kind,
        payload: input.payload as ToolApprovalPayload,
        status: 'pending',
        feedback: null,
      });
    },
    resolve: (input: { id: string; status: PendingApprovalStatus; feedback: string | null }) => {
      const row = rows.get(input.id);
      if (!row || row.status !== 'pending') return 0;
      row.status = input.status;
      row.feedback = input.feedback;
      return 1;
    },
    getById: (id: string) => rows.get(id) ?? null,
    rows,
  };
  return repo as unknown as PendingApprovalRepository & typeof repo;
}

const settings = (): AppSettings => ({
  permissions: {
    autoApprove: { read: true, write: true, execute: true, network: true },
    blockedCommands: [],
    devModeAutoApprove: true,
  },
} as unknown as AppSettings);

/** 有人值守 + devModeAutoApprove 全开：handback/ask 必须仍然弹卡，不得被自动放行。 */
function makeAttendedIsland(repo: ReturnType<typeof makeMemoryRepo>) {
  return new OrchestratorPermissionIsland({
    getSettings: settings,
    isDevModeAutoApproveEnabled: () => true,
    getExecutionTopology: () => 'main',
    hasApprovalUi: () => false,
    onEvent: vi.fn(),
    injectedPendingApprovalRepo: repo,
  });
}

function makeExecutor(island: OrchestratorPermissionIsland): ToolExecutor {
  return new ToolExecutor({
    requestPermission: (request) => island.requestPermission(request),
    workingDirectory: '/tmp/workbench',
  });
}

const SESSION = 'k2-handback-session';
const RUN_ID = 'k2-handback-run';

function startUnattendedRun(initiatingText: string, roleId?: string): void {
  getPermissionModeManager().markUnattendedSession(SESSION);
  beginRunPolicy(RUN_ID, SESSION, { roleId, initiatingText });
}

beforeEach(() => {
  resetPolicyEngine();
  resetPermissionModeManager();
  resolverState.getDefinition.mockReset();
  resolverState.execute.mockReset();
  resolverState.getDefinition.mockReturnValue(transferDefinition());
  resolverState.execute.mockResolvedValue({ success: true, output: 'transferred' });
  notifyCalls.length = 0;
});

afterEach(() => {
  endRunPolicy(RUN_ID);
  resetPermissionModeManager();
  resetPolicyEngine();
  vi.restoreAllMocks();
});

function isStillPending<T>(promise: Promise<T>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}

/** 等到停车行落库（execute → 分类 → requestPermission 是异步链，不能同步读）。 */
async function waitForPark(repo: ReturnType<typeof makeMemoryRepo>, timeoutMs = 5000): Promise<string> {
  const startedAt = Date.now();
  while (repo.rows.size === 0) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('parked approval row never appeared');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...repo.rows.keys()][0];
}

/** 等到 island 内存里出现待决请求（有人值守卡路径）。 */
async function waitForPendingRequest(
  island: OrchestratorPermissionIsland,
  timeoutMs = 5000,
): Promise<string> {
  const startedAt = Date.now();
  while (island.listPendingRequests().length === 0) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('pending permission request never appeared');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return island.listPendingRequests()[0].id;
}

describe('② 无人值守 handback：停车 + 通知，不执行、不失败', () => {
  it('命中 handback 规则：工具不执行、停车行带 handback 标记、通知用 handback 文案、run 挂起不失败', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'handback', rule: TRANSFER_TOOL }],
    });
    startUnattendedRun('月底给供应商打款');
    const repo = makeMemoryRepo();
    const island = makeAttendedIsland(repo);
    const executor = makeExecutor(island);

    const resultPromise = executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });

    // 停车挂起：工具不执行，等待人在收件箱裁决
    const rowId = await waitForPark(repo);
    expect(await isStillPending(resultPromise)).toBe(true);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const row = repo.rows.get(rowId);
    expect(row?.payload.handback).toBe(true);
    expect(row?.status).toBe('pending');
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toMatchObject({
      sessionId: SESSION,
      title: NL_RULE_K2_TEXT.notify.title,
      body: NL_RULE_K2_TEXT.notify.body(TRANSFER_TOOL),
    });

    // 「我做完了」：工具不执行，成功形回给模型（用户亲自做，勿重试），台账行收口、不留失败
    expect(island.handlePermissionResponse(rowId, 'user_did_it')).toBe('delivered');
    const toolResult: ToolExecutionResult = await resultPromise;
    expect(toolResult.success).toBe(true);
    expect(toolResult.output).toBe(NL_RULE_K2_TEXT.handbackDoneModelText(TRANSFER_TOOL));
    expect(toolResult.metadata?.failureCode).toBeUndefined();
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(repo.rows.get(rowId)?.status).toBe('rejected');
    expect(repo.rows.get(rowId)?.feedback).toBe('user did it themselves');
  });

  it('「让 Neo 做这一次」：执行一次', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'handback', rule: TRANSFER_TOOL }],
    });
    startUnattendedRun('月底给供应商打款');
    const repo = makeMemoryRepo();
    const island = makeAttendedIsland(repo);
    const executor = makeExecutor(island);

    const resultPromise = executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });
    const rowId = await waitForPark(repo);
    expect(await isStillPending(resultPromise)).toBe(true);
    expect(island.handlePermissionResponse(rowId, 'allow')).toBe('delivered');

    const toolResult = await resultPromise;
    expect(toolResult.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(repo.rows.get(rowId)?.status).toBe('approved');
  });
});

describe('① 有人值守 handback：绕过 devModeAutoApprove 强制真人两键', () => {
  it('devModeAutoApprove 全开仍弹 handback 卡（不自动放行）', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'handback', rule: TRANSFER_TOOL }],
    });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: '打款' });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: settings,
      isDevModeAutoApproveEnabled: () => true,
      getExecutionTopology: () => 'main',
      hasApprovalUi: () => false,
      onEvent: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
      injectedPendingApprovalRepo: makeMemoryRepo(),
    });
    const executor = makeExecutor(island);

    const resultPromise = executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });
    const request = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const found = events.find((event) => event.type === 'permission_request')?.data;
        if (found) {
          clearInterval(timer);
          resolve(found);
        } else if (Date.now() - startedAt > 5000) {
          clearInterval(timer);
          reject(new Error('permission_request event never emitted'));
        }
      }, 20);
    });
    expect(await isStillPending(resultPromise)).toBe(true);
    expect(request.handback).toBe(true);
    expect(request.forceConfirm).toBe(true);
  });
});

describe('① K1 ask 规则现在真的强制弹审批（已知安全命令也要问）', () => {
  it('旧表 ask 规则 + 已知安全命令：不走安全捷径，弹卡', async () => {
    getPolicyEngine().loadUserRules({ ask: ['Bash(git status)'] });
    beginRunPolicy(RUN_ID, SESSION, { roleId: undefined, initiatingText: '看看状态' });
    resolverState.getDefinition.mockReturnValue({
      name: 'Bash',
      description: 'run a shell command',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute' as const,
      readOnly: false,
    });
    const island = makeAttendedIsland(makeMemoryRepo());
    const executor = makeExecutor(island);

    const resultPromise = executor.execute('Bash', { command: 'git status' }, { sessionId: SESSION });
    const pendingId = await waitForPendingRequest(island);
    expect(await isStillPending(resultPromise)).toBe(true);
    expect(resolverState.execute).not.toHaveBeenCalled();

    // 拒绝后按用户拒绝收口（不是失败态，模型可继续）
    expect(island.handlePermissionResponse(pendingId, 'deny')).toBe('delivered');
    const denied: ToolExecutionResult = await resultPromise;
    expect(denied.success).toBe(false);
    expect(String(denied.error)).toContain('Permission denied by user');
  });
});

describe('④ preapprove：短语命中免卡，未命中出卡；deny 仍硬拒', () => {
  it('发起话包含触发短语：直接执行不弹卡', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: TRANSFER_TOOL, phrases: ['这笔我确认'] }],
    });
    startUnattendedRun('这笔我确认了，打款给供应商');
    const island = makeAttendedIsland(makeMemoryRepo());
    const executor = makeExecutor(island);

    const toolResult = await executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });
    expect(toolResult.success).toBe(true);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('发起话没有触发短语：弹卡（无人值守停车），不静默放行', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'preapprove', rule: TRANSFER_TOOL, phrases: ['这笔我确认'] }],
    });
    startUnattendedRun('月底例行打款');
    const repo = makeMemoryRepo();
    const island = makeAttendedIsland(repo);
    const executor = makeExecutor(island);

    const resultPromise = executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });
    const rowId = await waitForPark(repo);
    expect(await isStillPending(resultPromise)).toBe(true);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const row = repo.rows.get(rowId);
    expect(row?.payload.handback).toBeUndefined();
  });

  it('nlRules 的 deny 走既有 user-deny 硬拒链：工具不执行、run 不挂起', async () => {
    getPolicyEngine().loadUserRules({
      nlRules: [{ behavior: 'deny', rule: TRANSFER_TOOL }],
    });
    startUnattendedRun('打款');
    const island = makeAttendedIsland(makeMemoryRepo());
    const executor = makeExecutor(island);

    const toolResult = await executor.execute(TRANSFER_TOOL, { amount: 100 }, { sessionId: SESSION });
    expect(toolResult.success).toBe(false);
    expect(toolResult.error).toContain('Blocked by your permission rule');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
