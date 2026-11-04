// N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2：ADR-088 一期（密码框输入交回用户）。
// 真 ToolExecutor + in-memory app grants + mock 驱动反查/派发（骨架照抄
// toolExecutor.cuaApp.test.ts；快照夹具形如 0.14.2 get_window_state 真实输出，见
// docs/architecture/sensitive-step-handback.md）。判据：
// ① 窗口最新快照含 AXSecureTextField（索引行或未索引行）→ type_text/set_value 跳过
//    app_grant、弹 forceConfirm 交回卡；② 卡上无「记住」选项细节由 reasonCode/details
//    钉住（渲染测试在 tests/renderer）；③ 会话/长期授权在场仍弹卡（正常文本框仍免卡直跑）；
// ④ 被键入文本不进请求/台账/指纹；⑥ query 过滤与截断快照不翻转既有 true；
// 应答 allow/deny 都不执行原动作，回话模板按规格 §5。
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
import { computeLedgerArgsSurvival } from '../../../src/host/agent/parkedApprovalSurvival';

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const SHOP_PID = 4321;
const SHOP_WINDOW_ID = 7;
const SHOP = { name: 'Shop', bundleId: 'com.example.shop' };
const PASSWORD_TEXT = 'hunter2-super-secret';

/** cua-driver 0.14.2 get_window_state 的 output 形状（ax/tree.rs format_node_line）：头行 + 树。 */
function windowStateOutput(rows: string[]): string {
  return [`window_id=${SHOP_WINDOW_ID} pid=${SHOP_PID} size=430x222 elements=${rows.length}`, '', ...rows].join('\n');
}

/** 登录窗：含索引的 AXSecureTextField（真实登录页形状）。 */
const LOGIN_WINDOW = windowStateOutput([
  '- [0] AXWindow "Checkout"',
  '  - [1] AXStaticText "Order total ¥1,298.00"',
  '  - [2] AXTextField "Email"',
  '  - [3] AXSecureTextField "Password"',
  '  - [7] AXButton "Sign in" [actions=[press]]',
]);

/** 普通搜索窗：只有 AXTextField，无 secure 字段（控制组：不交回、授权后免卡直跑）。 */
const PLAIN_WINDOW = windowStateOutput([
  '- [0] AXWindow "Search"',
  '  - [2] AXTextField "Query"',
  '  - [7] AXButton "Go" [actions=[press]]',
]);

/** 未索引 secure 行：0.14.2 format_node_line 只给带 AX action 的节点编号，secure 行常无 [N]。 */
const UNINDEXED_SECURE_WINDOW = windowStateOutput([
  '- [0] AXWindow "Login"',
  '  - [2] AXTextField "Email"',
  '  - AXSecureTextField "密码"',
  '  - [7] AXButton "Sign in" [actions=[press]]',
]);

/** 与 mcpToolRegistry.mapCuaToolPermission 同口径的工具定义。 */
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

/** list_apps 真实形状（0.14.2 format_app_list；JSON 记录只在 structuredContent）。 */
function driverListApps() {
  return {
    success: true,
    output: `✅ Found 1 app(s): 1 running, 0 installed-not-running.\n- Shop (pid ${SHOP_PID}) [com.example.shop]`,
    metadata: { mcpStructuredContent: { apps: [{ pid: SHOP_PID, name: 'Shop', bundle_id: 'com.example.shop' }] } },
  };
}

describe('ToolExecutor cua sensitive step hand-back (ADR-088 phase 1)', () => {
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
    // 真实链路：模型先 get_window_state 过一次，mcpClient 观察结果喂缓存
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }, LOGIN_WINDOW);
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
  });

  function makeExecutor(approve: boolean, overrides: Record<string, unknown> = {}) {
    const requestPermission = vi.fn().mockResolvedValue(approve);
    const executor = new ToolExecutor({
      requestPermission,
      workingDirectory: '/tmp/workbench',
      ...overrides,
    });
    return { executor, requestPermission };
  }

  function typeIntoPasswordField() {
    return {
      tool: 'mcp__cua-driver__type_text',
      params: { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3, text: PASSWORD_TEXT },
      options: { sessionId: 's1' },
    };
  }

  it('a session grant does NOT silence the hand-back card: password field → forceConfirm request, step never executed', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const req = requestPermission.mock.calls[0][0];
    expect(req.forceConfirm).toBe(true);
    expect(req.type).toBe('dangerous_command');
    expect(req.reasonCode).toBe(PermissionRequestReason.SensitiveStepHandback);
    expect(req.details.sensitiveStep).toEqual({ kind: 'password', elementLabel: 'Password', appName: 'Shop' });
    expect(req.details.action).toBe('type_text');
    expect(req.details.targetApp).toBeUndefined();
    expect(req.dangerLevel).toBeUndefined();
    // ④ 被键入文本绝不进请求负载
    expect(JSON.stringify(requestPermission.mock.calls)).not.toContain(PASSWORD_TEXT);
    // 应答 allow = 用户已亲手完成：success true + done 模板（规格 §5），不是权限失败
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    expect(String(result.result)).toContain('"Password" (password)');
    expect(String(result.result)).toContain('I did NOT perform this step');
    expect(result.metadata).toMatchObject({ code: 'SENSITIVE_STEP_HANDBACK', outcome: 'done_by_user' });
  });

  it('a standing grant does NOT silence the hand-back card either', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantStanding(SHOP, 1);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('password');
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('deny = skip: still success:true with the skipped template, step still never executed', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(false);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(String(result.result)).toContain('SENSITIVE_STEP_SKIPPED_BY_USER');
    expect(String(result.result)).toContain('Do not retry this step');
    expect(result.metadata).toMatchObject({ code: 'SENSITIVE_STEP_HANDBACK', outcome: 'skipped' });
    // deny 的权限失败形态（PermissionDenied failureCode）不得出现——跳过不是失败
    expect(result.metadata?.failureCode).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('set_value and the invoke-time alias type_text_chars hit the same gate', async () => {
    for (const bareTool of ['set_value', 'type_text_chars']) {
      resolverState.getDefinition.mockReturnValue(cuaActionDefinition(bareTool));
      mintAppGrantSession('s1', SHOP);
      const { executor, requestPermission } = makeExecutor(true);
      const result = await executor.execute(
        `mcp__cua-driver__${bareTool}`,
        { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3, value: PASSWORD_TEXT },
        { sessionId: 's1' },
      );
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('password');
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
      requestPermission.mockClear();
    }
  });

  it('a normal text field in the same approved app still types with NO card (control)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: 9 }, PLAIN_WINDOW.replace('window_id=7', 'window_id=9'));
    const { executor, requestPermission } = makeExecutor(true);
    const result = await executor.execute(
      'mcp__cua-driver__type_text',
      { pid: SHOP_PID, window_id: 9, element_index: 2, text: 'neo@example.com' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({ outcome: 'auto-approve', reason: 'app_grant:bundle:com.example.shop' });
  });

  it('an un-indexed AXSecureTextField row (not in the element cache) still raises the card', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: 11 }, UNINDEXED_SECURE_WINDOW.replace('window_id=7', 'window_id=11'));
    const { executor, requestPermission } = makeExecutor(true);
    const result = await executor.execute(
      'mcp__cua-driver__type_text',
      { pid: SHOP_PID, window_id: 11, x: 120, y: 66, text: PASSWORD_TEXT },
      { sessionId: 's1' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.sensitiveStep).toEqual({
      kind: 'password',
      elementLabel: '密码',
      appName: 'Shop',
    });
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('a query-filtered snapshot never flips an existing true back to false', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    // 模型接着用 query 只看了按钮区（真实用法：query 是检索词，会滤掉其余行）
    recordCuaResult(
      'get_window_state',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, query: 'Sign in' },
      windowStateOutput(['  - [7] AXButton "Sign in" [actions=[press]]']),
    );
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('password');
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('a truncated snapshot never flips an existing true back to false', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    recordCuaResult(
      'get_window_state',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID },
      windowStateOutput(['- [0] AXWindow "Checkout"', '  - [7] AXButton "Pay now" [actions=[press]]'])
        + '\n\n[Output truncated: exceeded size limit. Use more specific queries to reduce output.]',
    );
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('a complete snapshot without any secure field clears the window flag (latest snapshot wins)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    // 登录完成后同一窗口变成普通页：完整快照（无 query）无 secure 行 → 不再交回
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }, PLAIN_WINDOW);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    const result = await executor.execute(tool, params, options);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('type_text carrying only pid checks every cached window of that pid', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: 21 }, LOGIN_WINDOW.replace('window_id=7', 'window_id=21'));
    const { executor, requestPermission } = makeExecutor(true);
    const result = await executor.execute(
      'mcp__cua-driver__type_text',
      { pid: SHOP_PID, text: PASSWORD_TEXT },
      { sessionId: 's1' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('password');
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('no snapshot cached for the window = no signal: the remembered grant runs as today (documented gap)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    resetCuaNarrationCacheForTest();
    const { executor, requestPermission } = makeExecutor(true);
    const result = await executor.execute(
      'mcp__cua-driver__type_text',
      { pid: SHOP_PID, window_id: 999, element_index: 3, text: PASSWORD_TEXT },
      { sessionId: 's1' },
    );
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({ outcome: 'auto-approve' });
  });

  it('the typed text never reaches the request payload, the ledger history, or the args fingerprint', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    options.currentToolCallId = 'toolu_sensitive_1';
    const result = await executor.execute(tool, params, options);
    expect(result.success).toBe(true);
    const req = requestPermission.mock.calls[0][0];
    expect(JSON.stringify(req)).not.toContain(PASSWORD_TEXT);
    // ④ 指纹输入剔除 text（规格 §3：低熵密码的哈希可被爆破）——等于剥掉 text 后的指纹，
    // 不等于含 text 的指纹。
    expect(req.argsFingerprint).toBe(
      computeLedgerArgsSurvival('mcp__cua-driver__type_text', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3 }).argsFingerprint,
    );
    expect(req.argsFingerprint).not.toBe(
      computeLedgerArgsSurvival('mcp__cua-driver__type_text', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3, text: PASSWORD_TEXT }).argsFingerprint,
    );
    // 台账（decision history + 交回调用的 recordDecision 入参形态）同样不含明文
    expect(JSON.stringify(getDecisionHistory().getRecent(5))).not.toContain(PASSWORD_TEXT);
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'] as const)(
    'the hand-back card is raised in permission mode %s',
    async (mode) => {
      resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
      mintAppGrantSession('s1', SHOP);
      const { executor, requestPermission } = makeExecutor(true, { permissionModeOverride: mode });
      const { tool, params, options } = typeIntoPasswordField();
      const result = await executor.execute(tool, params, options);
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(requestPermission.mock.calls[0][0].details.sensitiveStep?.kind).toBe('password');
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    },
  );

  it('answering twice in a row re-raises the card every time (nothing is ever remembered)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    const { executor, requestPermission } = makeExecutor(true);
    const { tool, params, options } = typeIntoPasswordField();
    await executor.execute(tool, params, options);
    await executor.execute(tool, params, options);
    await executor.execute(tool, params, options);
    expect(requestPermission).toHaveBeenCalledTimes(3);
    expect(resolverState.execute).not.toHaveBeenCalled();
  });
});
