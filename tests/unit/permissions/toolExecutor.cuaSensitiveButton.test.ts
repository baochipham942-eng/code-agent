// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU3：ADR-088 二期（支付/验证码/密码按钮点击交回用户）。
// 真 ToolExecutor + in-memory app grants；骨架同 toolExecutor.cuaSensitiveStep.test.ts。
// ① element_index 点击 join 缓存 label，命中词表 → 交回卡、不吃已记住授权；
// ③ 会话授权与长期授权在场仍弹卡，「Add to favourites」/「Upload」免卡直跑；⑤ 无人值守停车。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

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

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ callTool: mcpClientState.callTool }),
}));

import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  bindAppGrantDatabase,
  mintAppGrantSession,
  mintAppGrantStanding,
} from '../../../src/host/permissions/appGrantStore';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { PermissionRequestReason } from '../../../src/shared/contract/permission';
import {
  recordCuaResult,
  resetCuaNarrationCacheForTest,
} from '../../../src/host/mcp/cuaNarration';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { getPermissionModeManager } from '../../../src/host/permissions/modes';
import type { AppSettings } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const SHOP_PID = 4321;
const SHOP_WINDOW_ID = 7;
const SHOP = { name: 'Shop', bundleId: 'com.example.shop' };

/** cua-driver 0.14.2 get_window_state 的 output 形状（ax/tree.rs format_node_line）：头行 + 树。 */
function windowStateOutput(rows: string[]): string {
  return [`window_id=${SHOP_WINDOW_ID} pid=${SHOP_PID} size=430x222 elements=${rows.length}`, '', ...rows].join('\n');
}


const CART_WINDOW = windowStateOutput([
  '- [0] AXWindow "Cart"',
  '  - [2] AXButton "Add to favourites" [actions=[press]]',
  '  - [3] AXButton "Upload" [actions=[press]]',
  '  - [5] AXButton "Pay now" [actions=[press]]',
  '  - [6] AXButton "验证码" [actions=[press]]',
]);

function cuaActionDefinition(bareTool: string) {
  return {
    name: `mcp__cua-driver__${bareTool}`,
    description: `cua ${bareTool}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission: true,
    permissionLevel: 'execute' as const,
    readOnly: false,
  };
}

function driverListApps() {
  return {
    success: true,
    output: `✅ Found 1 app(s): 1 running, 0 installed-not-running.\n- Shop (pid ${SHOP_PID}) [com.example.shop]`,
    metadata: { mcpStructuredContent: { apps: [{ pid: SHOP_PID, name: 'Shop', bundle_id: 'com.example.shop' }] } },
  };
}

/** 内层真类型化（AppSettings['permissions'] 全量覆盖），外层 as 与 FU2 姊妹测试同款（部分 settings）。 */
function settings(): AppSettings {
  const permissions: AppSettings['permissions'] = {
    autoApprove: { read: false, write: false, execute: false, network: false },
    blockedCommands: [],
    devModeAutoApprove: false,
  };
  return { permissions } as AppSettings;
}

describe('ToolExecutor cua sensitive button click hand-back (ADR-088 phase 2)', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetDecisionHistory();
    resetPermissionModeManager();
    resetCuaNarrationCacheForTest();
    db = new Database(':memory:');
    applyAppGrantsSchema(db, logger as never);
    bindAppGrantDatabase(db, true);
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    mcpClientState.callTool.mockReset();
    mcpClientState.callTool.mockImplementation(async (_id: string, _s: string, toolName: string) =>
      toolName === 'list_apps' ? driverListApps() : { success: false, output: '' });
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }, CART_WINDOW);
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
  });

  function makeExecutor(approve: boolean) {
    const requestPermission = vi.fn().mockResolvedValue(approve);
    return { executor: new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' }), requestPermission };
  }

  const click = (bare: string, extra: Record<string, unknown>) => ({
    tool: `mcp__cua-driver__${bare}`,
    params: { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, ...extra },
  });

  for (const [grantName, mint] of [
    ['session grant', () => mintAppGrantSession('s1', SHOP)],
    ['standing grant', () => mintAppGrantStanding(SHOP, 1)],
  ] as const) {
    it(`${grantName} does NOT silence the card: "Pay now" → hand-back, driver untouched`, async () => {
      resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
      mint();
      const { executor, requestPermission } = makeExecutor(true);
      const { tool, params } = click('click', { element_index: 5 });
      const result = await executor.execute(tool, params, { sessionId: 's1' });
      expect(requestPermission).toHaveBeenCalledTimes(1);
      const req = requestPermission.mock.calls[0][0];
      expect(req.forceConfirm).toBe(true);
      expect(req.reasonCode).toBe(PermissionRequestReason.SensitiveStepHandback);
      expect(req.details.sensitiveStep).toEqual({ kind: 'payment', elementLabel: 'Pay now', appName: 'Shop' });
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    });
  }

  it('right_click / double_click on a verification-code button hit too; deny = skipped template', async () => {
    mintAppGrantSession('s1', SHOP);
    for (const bare of ['double_click', 'right_click']) {
      resolverState.getDefinition.mockReturnValue(cuaActionDefinition(bare));
      const { executor, requestPermission } = makeExecutor(false);
      const { tool, params } = click(bare, { element_index: 6 });
      const result = await executor.execute(tool, params, { sessionId: 's1' });
      expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('verification_code');
      expect(String(result.result)).toContain('SENSITIVE_STEP_SKIPPED_BY_USER');
      expect(resolverState.execute).not.toHaveBeenCalled();
    }
  });

  it.each([[2, 'Add to favourites'], [3, 'Upload']])('ordinary button %i (%s) runs with NO card under the remembered grant', async (index) => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params } = click('click', { element_index: index });
    const result = await executor.execute(tool, params, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({ outcome: 'auto-approve', reason: 'app_grant:bundle:com.example.shop' });
  });

  it('pixel (x/y) click falls back to the window-level signal: the cart window holds "Pay now" → card', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params } = click('click', { x: 120, y: 80 });
    await executor.execute(tool, params, { sessionId: 's1' });
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('payment');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('pixel click in a window with no sensitive button, or with no cached snapshot, runs as today (documented gap)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mintAppGrantSession('s1', SHOP);
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: 9 },
      windowStateOutput(['- [0] AXWindow "List"', '  - [2] AXButton "Upload" [actions=[press]]']).replace('window_id=7', 'window_id=9'));
    const { executor, requestPermission } = makeExecutor(true);
    await executor.execute('mcp__cua-driver__click', { pid: SHOP_PID, window_id: 9, x: 5, y: 5 }, { sessionId: 's1' });
    await executor.execute('mcp__cua-driver__click', { pid: SHOP_PID, window_id: 404, x: 5, y: 5 }, { sessionId: 's1' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(2);
  });

  it('unattended session: the "Pay now" click is parked (not auto-approved, not failed) (⑤)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mintAppGrantSession('s-cron', SHOP);
    getPermissionModeManager().markUnattendedSession('s-cron');
    const events: Array<{ type: string; data: { id: string } }> = [];
    const insert = vi.fn();
    const island = new OrchestratorPermissionIsland({
      getSettings: () => settings(),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event as never),
      injectedPendingApprovalRepo: { insert, resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    });
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request as Omit<PermissionRequest, 'id' | 'timestamp'>),
      workingDirectory: '/tmp/workbench',
    });
    let settled: unknown;
    const { tool, params } = click('click', { element_index: 5 });
    const run = executor.execute(tool, params, { sessionId: 's-cron', currentToolCallId: 'toolu_pay_1' }).then((r) => { settled = r; return r; });
    let event: (typeof events)[number] | undefined;
    for (let i = 0; i < 50 && !event; i += 1) {
      event = events.find((e) => e.type === 'permission_request');
      if (!event) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(event).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeUndefined();
    expect(insert).toHaveBeenCalledOnce();
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(island.resolveParkedApproval(event!.data.id, 'allow')).toBe(true);
    const result = await run;
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
