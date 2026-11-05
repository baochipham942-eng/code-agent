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

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: loggerSpies,
  createLogger: () => loggerSpies,
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => ({ callTool: mcpClientState.callTool }),
}));

import type { AppSettings } from '../../../src/shared/contract';
import type { PermissionRequest } from '../../../src/shared/contract/permission';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import { resetDecisionHistory, getDecisionHistory } from '../../../src/host/security/decisionHistory';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { applyAppGrantsSchema } from '../../../src/host/services/core/database/schemaAppGrants';
import {
  bindAppGrantDatabase,
  listAppGrants,
  listAppSessionGrants,
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
    loggerSpies.debug.mockClear();
    loggerSpies.info.mockClear();
    loggerSpies.warn.mockClear();
    loggerSpies.error.mockClear();
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

  function typeIntoPasswordField(options: { sessionId: string; currentToolCallId?: string } = { sessionId: 's1' }) {
    return {
      tool: 'mcp__cua-driver__type_text',
      params: { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, element_index: 3, text: PASSWORD_TEXT },
      options,
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
    const { tool, params, options } = typeIntoPasswordField({ sessionId: 's1', currentToolCallId: 'toolu_sensitive_1' });
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

  // --------------------------------------------------------------------------
  // N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU2-FU2：窗口级交回扩到可产出字符的按键与粘贴快捷键
  // --------------------------------------------------------------------------

  it('password window + printable press_key ("p" and shift+"Z") → forceConfirm hand-back card, driver never called, no grant minted, key absent from request/ledger/fingerprint', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('press_key'));
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);

    const resLower = await executor.execute(
      'mcp__cua-driver__press_key',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, key: 'p' },
      { sessionId: 's1', currentToolCallId: 'toolu_pk_p' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const reqLower = requestPermission.mock.calls[0][0];
    expect(reqLower.forceConfirm).toBe(true);
    expect(reqLower.type).toBe('dangerous_command');
    expect(reqLower.reasonCode).toBe(PermissionRequestReason.SensitiveStepHandback);
    expect(reqLower.details).toEqual({
      sensitiveStep: { kind: 'password', elementLabel: 'Password', appName: 'Shop' },
      action: 'press_key',
    });
    expect(reqLower.argsFingerprint).toBe(
      computeLedgerArgsSurvival('mcp__cua-driver__press_key', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }).argsFingerprint,
    );
    expect(reqLower.argsFingerprint).not.toBe(
      computeLedgerArgsSurvival('mcp__cua-driver__press_key', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, key: 'p' }).argsFingerprint,
    );
    expect(resLower.success).toBe(true);
    expect(String(resLower.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    expect(String(resLower.result)).toContain('I did NOT perform this step');

    // shift 修饰的可打印字符（"Z" 不出现在任何元数据单词里，可直接做整串零残留断言）
    requestPermission.mockClear();
    const resShift = await executor.execute(
      'mcp__cua-driver__press_key',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, key: 'Z', modifiers: ['shift'] },
      { sessionId: 's1', currentToolCallId: 'toolu_pk_2' },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).not.toHaveBeenCalled();
    const reqShift = requestPermission.mock.calls[0][0];
    expect(JSON.stringify(reqShift)).not.toContain('Z');
    expect(JSON.stringify(reqShift)).not.toContain('shift');
    expect(reqShift.argsFingerprint).toBe(
      computeLedgerArgsSurvival('mcp__cua-driver__press_key', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }).argsFingerprint,
    );
    expect(JSON.stringify(getDecisionHistory().getRecent(5))).not.toContain('"key"');
    expect(JSON.stringify(getDecisionHistory().getRecent(5))).not.toContain('Z');
    expect(resShift.success).toBe(true);
  });

  it('password window + paste hotkey (cmd+v / ctrl+v / cmd+shift+v) → forceConfirm hand-back card, driver never called, keys absent from request/ledger/fingerprint', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('hotkey'));
    mintAppGrantStanding(SHOP, 1);

    let callIdx = 0;
    for (const keys of [['cmd', 'v'], ['Command', 'V'], ['ctrl', 'v'], ['cmd', 'shift', 'v']]) {
      callIdx += 1;
      const { executor, requestPermission } = makeExecutor(true);
      const result = await executor.execute(
        'mcp__cua-driver__hotkey',
        { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, keys },
        { sessionId: 's1', currentToolCallId: `toolu_hk_${callIdx}` },
      );
      expect(requestPermission).toHaveBeenCalledTimes(1);
      expect(resolverState.execute).not.toHaveBeenCalled();
      const req = requestPermission.mock.calls[0][0];
      expect(req.forceConfirm).toBe(true);
      expect(req.reasonCode).toBe(PermissionRequestReason.SensitiveStepHandback);
      expect(req.details).toEqual({
        sensitiveStep: { kind: 'password', elementLabel: 'Password', appName: 'Shop' },
        action: 'hotkey',
      });
      expect(JSON.stringify(req)).not.toContain('"keys"');
      expect(req.argsFingerprint).toBe(
        computeLedgerArgsSurvival('mcp__cua-driver__hotkey', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID }).argsFingerprint,
      );
      expect(req.argsFingerprint).not.toBe(
        computeLedgerArgsSurvival('mcp__cua-driver__hotkey', { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, keys }).argsFingerprint,
      );
      expect(JSON.stringify(getDecisionHistory().getRecent(5))).not.toContain('"keys"');
      expect(result.success).toBe(true);
      expect(String(result.result)).toContain('SENSITIVE_STEP_DONE_BY_USER');
    }
  });

  it('password window + press_key / paste hotkey through real OrchestratorPermissionIsland mints NO grant for any answer', async () => {
    const events: Array<{ type: string; data: PermissionRequest & { id: string } }> = [];
    const island = new OrchestratorPermissionIsland({
      getSettings: () => ({
        permissions: {
          autoApprove: { read: false, write: false, execute: false, network: false },
          blockedCommands: [],
          devModeAutoApprove: false,
        },
      } as unknown as AppSettings),
      isDevModeAutoApproveEnabled: () => false,
      getExecutionTopology: () => 'async_agent',
      hasApprovalUi: () => true,
      onEvent: (event) => events.push(event as { type: string; data: PermissionRequest & { id: string } }),
      injectedPendingApprovalRepo: { insert: vi.fn(), resolve: vi.fn(() => 1) } as unknown as PendingApprovalRepository,
    });
    const executor = new ToolExecutor({
      requestPermission: (request) => island.requestPermission(request as Omit<PermissionRequest, 'id' | 'timestamp'>),
      workingDirectory: '/tmp/workbench',
    });

    const cases: Array<{
      bareTool: string;
      params: Record<string, unknown>;
      response: 'allow_session' | 'allow_standing';
    }> = [
      { bareTool: 'press_key', params: { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, key: 'p' }, response: 'allow_session' },
      { bareTool: 'hotkey', params: { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, keys: ['cmd', 'v'] }, response: 'allow_standing' },
    ];
    for (const { bareTool, params, response } of cases) {
      events.length = 0;
      resolverState.getDefinition.mockReturnValue(cuaActionDefinition(bareTool));
      const pending = executor.execute(`mcp__cua-driver__${bareTool}`, params, { sessionId: 's-no-mint' });
      let event: (typeof events)[number] | undefined;
      for (let i = 0; i < 30 && !event; i += 1) {
        event = events.find((e) => e.type === 'permission_request');
        if (!event) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(event).toBeTruthy();
      expect(island.handlePermissionResponse(event!.data.id, response)).toBe('delivered');
      const result = await pending;
      expect(result.success).toBe(true);
      expect(resolverState.execute).not.toHaveBeenCalled();
      expect(listAppGrants(Date.now())).toHaveLength(0);
      expect(listAppSessionGrants()).toHaveLength(0);
    }
  });

  it('password window + navigation/control keys (Return / Tab / Escape / arrows / Delete) and non-paste hotkeys (cmd+a / cmd+c / cmd+tab) are NOT handed back (old chain)', async () => {
    mintAppGrantSession('s1', SHOP);
    const { executor, requestPermission } = makeExecutor(true);

    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('press_key'));
    for (const keyParams of [
      { key: 'Return' },
      { key: 'Tab' },
      { key: 'Tab', modifiers: ['shift'] },
      { key: 'Escape' },
      { key: 'down' },
      { key: 'Delete' },
      { key: 'a', modifiers: ['cmd'] },
    ]) {
      resolverState.execute.mockClear();
      const result = await executor.execute(
        'mcp__cua-driver__press_key',
        { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, ...keyParams },
        { sessionId: 's1' },
      );
      expect(result.success).toBe(true);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
    }

    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('hotkey'));
    for (const keys of [['cmd', 'a'], ['cmd', 'c'], ['cmd', 'tab'], ['ctrl', 'a']]) {
      resolverState.execute.mockClear();
      const result = await executor.execute(
        'mcp__cua-driver__hotkey',
        { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, keys },
        { sessionId: 's1' },
      );
      expect(result.success).toBe(true);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
    }

    // 未铸授权时仍走原按应用审批链（普通 targetApp 卡，非 SensitiveStepHandback，批准后真调驱动）
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('press_key'));
    resolverState.execute.mockClear();
    const { executor: ungrantedExec, requestPermission: ungrantedAsk } = makeExecutor(true);
    const ungrantedRes = await ungrantedExec.execute(
      'mcp__cua-driver__press_key',
      { pid: SHOP_PID, window_id: SHOP_WINDOW_ID, key: 'Return' },
      { sessionId: 's-ungranted' },
    );
    expect(ungrantedRes.success).toBe(true);
    expect(ungrantedAsk).toHaveBeenCalledTimes(1);
    expect(ungrantedAsk.mock.calls[0][0].reasonCode).not.toBe(PermissionRequestReason.SensitiveStepHandback);
    expect(ungrantedAsk.mock.calls[0][0].forceConfirm).toBeFalsy();
    expect(ungrantedAsk.mock.calls[0][0].details.sensitiveStep).toBeUndefined();
    expect(ungrantedAsk.mock.calls[0][0].details.targetApp).toEqual(SHOP);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('normal window (no secure field) + printable press_key ("p") and paste hotkey (cmd+v) are NOT handed back (old chain)', async () => {
    mintAppGrantSession('s1', SHOP);
    recordCuaResult('get_window_state', { pid: SHOP_PID, window_id: 9 }, PLAIN_WINDOW.replace('window_id=7', 'window_id=9'));
    const { executor, requestPermission } = makeExecutor(true);

    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('press_key'));
    const keyRes = await executor.execute(
      'mcp__cua-driver__press_key',
      { pid: SHOP_PID, window_id: 9, key: 'p' },
      { sessionId: 's1' },
    );
    expect(keyRes.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);

    resolverState.execute.mockClear();
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('hotkey'));
    const hkRes = await executor.execute(
      'mcp__cua-driver__hotkey',
      { pid: SHOP_PID, window_id: 9, keys: ['cmd', 'v'] },
      { sessionId: 's1' },
    );
    expect(hkRes.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('no snapshot cached + printable press_key / paste hotkey → old chain plus the debug gap log (without secret key text)', async () => {
    mintAppGrantSession('s1', SHOP);
    resetCuaNarrationCacheForTest();
    const { executor, requestPermission } = makeExecutor(true);

    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('press_key'));
    const keyRes = await executor.execute(
      'mcp__cua-driver__press_key',
      { pid: SHOP_PID, window_id: 999, key: 'Q' },
      { sessionId: 's1' },
    );
    expect(keyRes.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(loggerSpies.debug).toHaveBeenCalledWith(
      'cua sensitive step: no window snapshot cached, no signal (gap)',
      { tool: 'mcp__cua-driver__press_key', pid: SHOP_PID, windowId: 999 },
    );
    expect(JSON.stringify(loggerSpies.debug.mock.calls)).not.toContain('"Q"');

    loggerSpies.debug.mockClear();
    resolverState.execute.mockClear();
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('hotkey'));
    const hkRes = await executor.execute(
      'mcp__cua-driver__hotkey',
      { pid: SHOP_PID, window_id: 999, keys: ['cmd', 'v'] },
      { sessionId: 's1' },
    );
    expect(hkRes.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    expect(loggerSpies.debug).toHaveBeenCalledWith(
      'cua sensitive step: no window snapshot cached, no signal (gap)',
      { tool: 'mcp__cua-driver__hotkey', pid: SHOP_PID, windowId: 999 },
    );
  });
});
