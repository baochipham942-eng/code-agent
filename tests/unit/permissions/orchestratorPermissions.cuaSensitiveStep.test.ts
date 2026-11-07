// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2：ADR-088 一期的 orchestrator 侧与全链路判据。
// 真 OrchestratorPermissionIsland（骨架照抄 parkedApprovalArgsPreview / computerAppGrant）：
// ② 交回应答（allow/allow_session/allow_standing）永不铸造任何授权行（含 allow_session
//    无 targetApp 时回落 recordApproval 的会话级放行）；对照臂证明判据咬得住；
// ③ devModeAutoApprove / autoApprove[level] 对 forceConfirm 交回请求不自动放行；
// ⑤ 无人值守会话里交回请求停车挂起（写台账、run 不失败不自动批），裁决后按 allow/deny 收口；
// ⑧ 真 ToolExecutor + 真 island 全链路：已记住应用授权 + 密码框 → 停车交回 → 台账裁决 allow
//    → DONE_BY_USER 回话，驱动派发全程未发生。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { ToolApprovalPayload } from '../../../src/shared/contract/pendingApproval';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

const resolverState = vi.hoisted(() => ({
  getDefinition: vi.fn(),
  execute: vi.fn(),
}));

const mcpClientState = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: resolverState.getDefinition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ callTool: mcpClientState.callTool }),
}));

import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  bindAppGrantDatabase,
  listAppGrants,
  listAppSessionGrants,
  mintAppGrantSession,
} from '../../../src/host/permissions/appGrantStore';
import { resetDecisionHistory } from '../../../src/host/security/decisionHistory';
import { recordCuaResult, resetCuaNarrationCacheForTest } from '../../../src/host/mcp/cuaNarration';

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
const SHOP_PID = 4321;
const SHOP_WINDOW_ID = 7;
const SHOP = { name: 'Shop', bundleId: 'com.example.shop' };
const PASSWORD_TEXT = 'hunter2-super-secret';

const LOGIN_WINDOW = [
  `window_id=${SHOP_WINDOW_ID} pid=${SHOP_PID} size=430x222 elements=5`,
  '',
  '- [0] AXWindow "Checkout"',
  '  - [2] AXTextField "Email"',
  '  - [3] AXSecureTextField "Password"',
  '  - [7] AXButton "Sign in" [actions=[press]]',
].join('\n');

const settings = (overrides: Partial<AppSettings['permissions']> = {}): AppSettings => ({
  permissions: {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
    ...overrides,
  },
} as AppSettings);

function makeRepo() {
  const insert = vi.fn();
  return {
    repo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    insert,
  };
}

/** 交回请求的真实形状（toolExecutor decorateSensitiveStepRequest 的产物）。 */
function handbackRequest(sessionId: string): Omit<PermissionRequest, 'id' | 'timestamp'> {
  return {
    sessionId,
    type: 'dangerous_command',
    tool: 'mcp__cua-driver__type_text',
    forceConfirm: true,
    reasonCode: PermissionRequestReason.SensitiveStepHandback,
    reason: '这一步请你亲手完成',
    details: {
      sensitiveStep: { kind: 'password', elementLabel: 'Password', appName: 'Shop' },
      action: 'type_text',
    },
  };
}

type PermissionEvent = { type: string; data: PermissionRequest & { id: string } };

function makeIsland({
  insert,
  events,
  devModeAutoApprove = false,
  autoApproveAll = false,
}: {
  insert: ReturnType<typeof vi.fn>;
  events: PermissionEvent[];
  devModeAutoApprove?: boolean;
  autoApproveAll?: boolean;
}) {
  return new OrchestratorPermissionIsland({
    getSettings: () => settings(autoApproveAll ? { autoApprove: { read: true, write: true, execute: true, network: true } } : {}),
    isDevModeAutoApproveEnabled: () => devModeAutoApprove,
    getExecutionTopology: () => 'async_agent',
    hasApprovalUi: () => true,
    onEvent: (event) => events.push(event as PermissionEvent),
    injectedPendingApprovalRepo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
  });
}

describe('orchestrator: sensitive step hand-back requests (ADR-88 phase 1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetPermissionModeManager();
    resetDecisionHistory();
    resetCuaNarrationCacheForTest();
    db = new Database(':memory:');
    applyAppGrantsSchema(db, logger as never);
    bindAppGrantDatabase(db, true);
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    mcpClientState.callTool.mockReset();
    mcpClientState.callTool.mockImplementation(async (_id: string, _s: string, toolName: string) =>
      toolName === 'list_apps'
        ? {
            success: true,
            output: `✅ Found 1 app(s): 1 running, 0 installed-not-running.\n- Shop (pid ${SHOP_PID}) [com.example.shop]`,
            metadata: { mcpStructuredContent: { apps: [{ pid: SHOP_PID, name: 'Shop', bundle_id: 'com.example.shop' }] } },
          }
        : { success: false, output: '' });
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
  });

  it('never mints any grant for any answer on a hand-back request (②)', async () => {
    for (const response of ['allow', 'allow_session', 'allow_standing'] as const) {
      const events: PermissionEvent[] = [];
      const { insert } = makeRepo();
      const island = makeIsland({ insert, events });
      const promise = island.requestPermission(handbackRequest('s-hb'));
      const event = events.find((e) => e.type === 'permission_request');
      if (!event) throw new Error('no permission_request event');
      expect(island.handlePermissionResponse(event.data.id, response)).toBe('delivered');
      const result = await promise;
      // 循环里只有 allow 形态（deny 在渲染/island 测试里另有用例），这里三种应答都应放行
      expect(result).toEqual({ approved: true, approvalSource: 'user' } as PermissionAskResult);
      expect(listAppGrants(Date.now())).toHaveLength(0);
      expect(listAppSessionGrants()).toHaveLength(0);
    }
  });

  it('control arm: the same answers on a normal targetApp request DO mint (the check bites)', async () => {
    const events: PermissionEvent[] = [];
    const { insert } = makeRepo();
    const island = makeIsland({ insert, events });
    const promise = island.requestPermission({
      sessionId: 's-ctl',
      type: 'command',
      tool: 'mcp__cua-driver__click',
      details: { targetApp: SHOP },
    });
    const event = events.find((e) => e.type === 'permission_request');
    if (!event) throw new Error('no permission_request event');
    island.handlePermissionResponse(event.data.id, 'allow_session');
    const result = await promise;
    expect(result.approved).toBe(true);
    expect(listAppSessionGrants()).toHaveLength(1); // 对照臂：普通请求 allow_session 铸会话授权
    // hand-back 臂已在上一条用例证零铸造；此处证明判据不是恒零
  });

  it('devModeAutoApprove and autoApprove[level] do not auto-approve a forceConfirm hand-back (③)', async () => {
    const events: PermissionEvent[] = [];
    const { insert } = makeRepo();
    const island = makeIsland({ insert, events, devModeAutoApprove: true, autoApproveAll: true });
    let settled: PermissionAskResult | undefined;
    const promise = island.requestPermission(handbackRequest('s-att')).then((r) => { settled = r; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined(); // 没被任何自动放行吞掉，仍在等真人
    const event = events.find((e) => e.type === 'permission_request');
    if (!event) throw new Error('no permission_request event');
    island.handlePermissionResponse(event.data.id, 'deny');
    const result = await promise;
    expect(result.approved).toBe(false);
  });

  it('parks the hand-back in an unattended session: row written, not auto-approved, not failed (⑤)', async () => {
    const events: PermissionEvent[] = [];
    const { insert } = makeRepo();
    const island = makeIsland({ insert, events });
    getPermissionModeManager().markUnattendedSession('s-cron');
    let settled: PermissionAskResult | undefined;
    const promise = island.requestPermission(handbackRequest('s-cron')).then((r) => { settled = r; return r; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined(); // parked：挂起等待，不是失败返回
    expect(insert).toHaveBeenCalledOnce();
    const insertInput = (insert.mock.calls[0] as unknown as [{ id: string; kind: string; payload: ToolApprovalPayload }])[0];
    expect(insertInput.kind).toBe('tool_approval');
    const payload = insertInput.payload;
    expect(payload.sensitiveStep).toEqual({ kind: 'password', elementLabel: 'Password', appName: 'Shop' });
    expect(payload.argsPreview).toBeUndefined(); // 交回请求不补 command/path/url/changes
    expect(payload.standingGrantTarget).toBeNull(); // 无铸权入口
    const event = events.find((e) => e.type === 'permission_request');
    if (!event) throw new Error('no permission_request event');
    expect(event.data.reasonCode).toBe(PermissionRequestReason.SensitiveStepHandback);
    // 收件箱裁决口：完成后继续（allow）
    expect(island.resolveParkedApproval(event.data.id, 'allow')).toBe(true);
    const result = await promise;
    expect(result).toEqual({ approved: true, approvalSource: 'user' });
    expect(listAppGrants(Date.now())).toHaveLength(0); // 停车裁决同样不铸造
  });

  it('full chain: real ToolExecutor + real island, remembered grant + password field → parked hand-back, allow → DONE_BY_USER, driver untouched (⑧)', async () => {
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }, LOGIN_WINDOW);
    mintAppGrantSession('s-chain', SHOP);
    resolverState.getDefinition.mockReturnValue({
      name: 'mcp__cua-driver__type_text',
      description: 'cua type_text',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute' as const,
      readOnly: false,
    });
    const events: PermissionEvent[] = [];
    const { insert } = makeRepo();
    const island = makeIsland({ insert, events });
    getPermissionModeManager().markUnattendedSession('s-chain');
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request as Omit<PermissionRequest, 'id' | 'timestamp'>),
      workingDirectory: '/tmp/workbench',
    });
    let settled: { success: boolean; result?: unknown } | undefined;
    const execPromise = executor.execute(
      'mcp__cua-driver__type_text',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3, text: PASSWORD_TEXT },
      { sessionId: 's-chain', currentToolCallId: 'toolu_chain_1' },
    ).then((r) => { settled = r as { success: boolean; result?: unknown }; return r; });
    // 等停车卡出现（不轮询模型，只等事件）
    let event: PermissionEvent | undefined;
    for (let i = 0; i < 50 && !event; i += 1) {
      event = events.find((e) => e.type === 'permission_request');
      if (!event) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(event).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined(); // 仍在停车挂起
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(event!.data.forceConfirm).toBe(true);
    expect(event!.data.details.sensitiveStep).toEqual({ kind: 'password', elementLabel: 'Password', appName: 'Shop' });
    expect(JSON.stringify(event)).not.toContain(PASSWORD_TEXT);
    expect(insert).toHaveBeenCalledOnce();
    // 会话卡/收件箱点「完成后继续」
    expect(island.resolveParkedApproval(event!.data.id, 'allow')).toBe(true);
    const result = await execPromise;
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    expect(resolverState.execute).not.toHaveBeenCalled(); // 驱动派发全程未发生
    expect(listAppSessionGrants()).toHaveLength(1); // 只有 beforeEach 铸的那条既有授权，没有新铸造
  });
});
