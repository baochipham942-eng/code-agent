// N-COMPUTERUSE-CUADRIVER-APPGRANT：cua-driver 原生 MCP 工具（mcp__cua-driver__*）的
// 按应用授权。真 ToolExecutor + mock 掉 driver 反查（mcpClient.callTool）与工具派发
// （toolResolver.execute 即驱动调用边界），验证：未授权弹卡带对 targetApp、会话/长期
// 授权命中免卡、拒绝不碰驱动、反查失败/无 pid fail-closed、换应用重新问、元数据工具
// 永不问、应用内容读取（requiresPermission=false）也被 force 进审批且 skill 预授权
// 绕不过、pid 复用按反查结果判。
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
import { getPermissionModeManager, resetPermissionModeManager } from '../../../src/host/permissions/modes';

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

/** 与 mcpToolRegistry.mapCuaToolPermission 同口径的工具定义。 */
function cuaDefinition(bareTool: string, requiresPermission: boolean) {
  return {
    name: `mcp__cua-driver__${bareTool}`,
    description: `cua ${bareTool}`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresPermission,
    permissionLevel: requiresPermission ? ('execute' as const) : ('read' as const),
    readOnly: !requiresPermission,
  };
}

function cuaActionDefinition(bareTool: string) {
  return cuaDefinition(bareTool, true);
}

function cuaReadDefinition(bareTool: string) {
  return cuaDefinition(bareTool, false);
}

function driverListAppsOutput(apps: Array<Record<string, unknown>>) {
  return JSON.stringify({ apps });
}

function driverListWindowsOutput(windows: Array<Record<string, unknown>>) {
  return JSON.stringify({ windows });
}

describe('ToolExecutor cua-driver app grants', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetDecisionHistory();
    resetPermissionModeManager();
    db = new Database(':memory:');
    applyAppGrantsSchema(db, logger as never);
    bindAppGrantDatabase(db, true);
    resolverState.getDefinition.mockReset();
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    mcpClientState.callTool.mockReset();
    mcpClientState.callTool.mockResolvedValue({ success: false, output: '' });
  });

  afterEach(() => {
    resetPermissionModeManager();
    db.close();
  });

  function driverLookupResolves(outputByTool: Record<string, string>) {
    mcpClientState.callTool.mockImplementation(
      async (_id: string, _server: string, toolName: string) => ({
        success: true,
        output: outputByTool[toolName] ?? '',
      }),
    );
  }

  it('asks with the resolved target app before a grant exists', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 111, x: 10, y: 20 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({
      name: 'Calculator',
      bundleId: 'com.apple.calculator',
    });
    expect(mcpClientState.callTool).toHaveBeenCalledWith(
      expect.any(String),
      'cua-driver',
      'list_apps',
      {},
      expect.anything(),
    );
  });

  it('skips the ask when a session grant matches', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    mintAppGrantSession('s1', { name: 'Calculator', bundleId: 'com.apple.calculator' });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 111, x: 10, y: 20 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
    const [entry] = getDecisionHistory().getRecent(1);
    expect(entry).toMatchObject({ outcome: 'auto-approve', reason: 'app_grant:bundle:com.apple.calculator' });
  });

  it('skips the ask when a standing grant matches', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('type_text'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    mintAppGrantStanding({ name: 'Calculator', bundleId: 'com.apple.calculator' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__type_text',
      { pid: 111, text: '1+1' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('deny leaves the driver untouched and returns a model-visible refusal naming the app', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    const requestPermission = vi.fn().mockResolvedValue(false);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 111, x: 10, y: 20 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(false);
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('access to Calculator was denied');
  });

  it('fails closed without touching the driver when the pid lookup fails', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mcpClientState.callTool.mockResolvedValue({ success: false, output: '' });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 111, x: 10, y: 20 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('list_apps');
  });

  it('fails closed for a pid-less / window-less action instead of allowing global input', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { x: 10, y: 20 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(mcpClientState.callTool).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('pid');
  });

  it('resolves an app from window_id via list_windows (zoom)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaReadDefinition('zoom'));
    driverLookupResolves({
      list_windows: driverListWindowsOutput([{ window_id: 55, pid: 111, app_name: 'Calculator' }]),
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__zoom',
      { window_id: 55, x1: 0, y1: 0, x2: 10, y2: 10 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({ name: 'Calculator' });
  });

  it('asks again when the resolved app differs from the granted one', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([
        { pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' },
        { pid: 222, name: 'TextEdit', bundle_id: 'com.apple.TextEdit' },
      ]),
    });
    mintAppGrantStanding({ name: 'Calculator', bundleId: 'com.apple.calculator' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 222, x: 1, y: 2 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({
      name: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
    });
  });

  it('evaluates a reused pid as the app the live lookup now returns', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('click'));
    mcpClientState.callTool.mockImplementation(async (_id: string, _server: string, toolName: string) => ({
      success: true,
      output: toolName === 'list_apps'
        ? driverListAppsOutput([{ pid: 111, name: 'TextEdit' }])
        : '',
    }));
    // 昨天按 bundle 记的 Calculator 授权；今天 pid 111 已是 TextEdit——不命中，重新问。
    mintAppGrantStanding({ name: 'Calculator', bundleId: 'com.apple.calculator' }, 1);
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__click',
      { pid: 111, x: 1, y: 2 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({ name: 'TextEdit' });
  });

  it('never asks for metadata tools (list_apps / list_windows)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaReadDefinition('list_apps'));
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('mcp__cua-driver__list_apps', {}, { sessionId: 's1' });
    expect(result.success).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(mcpClientState.callTool).not.toHaveBeenCalled();
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('never asks for whole-desktop reads (get_desktop_state / get_accessibility_tree / screenshot)', async () => {
    for (const bareTool of ['get_desktop_state', 'get_accessibility_tree', 'screenshot']) {
      resolverState.getDefinition.mockReturnValue(cuaReadDefinition(bareTool));
      const requestPermission = vi.fn().mockResolvedValue(true);
      const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
      const result = await executor.execute(`mcp__cua-driver__${bareTool}`, {}, { sessionId: 's1' });
      expect(result.success).toBe(true);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(mcpClientState.callTool).not.toHaveBeenCalled();
      expect(resolverState.execute).toHaveBeenCalledTimes(1);
      resolverState.execute.mockClear();
    }
  });

  it('asks for app-content reads (get_window_state) even though requiresPermission is false', async () => {
    resolverState.getDefinition.mockReturnValue(cuaReadDefinition('get_window_state'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__get_window_state',
      { pid: 111, window_id: 55 },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({
      name: 'Calculator',
      bundleId: 'com.apple.calculator',
    });
  });

  it('a skill pre-approval does not bypass the app-content read gate', async () => {
    resolverState.getDefinition.mockReturnValue(cuaReadDefinition('get_window_state'));
    driverLookupResolves({
      list_apps: driverListAppsOutput([{ pid: 111, name: 'Calculator', bundle_id: 'com.apple.calculator' }]),
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__get_window_state',
      { pid: 111, window_id: 55 },
      { sessionId: 's1', preApprovedTools: new Set(['mcp__cua-driver__get_window_state']) },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(resolverState.execute).toHaveBeenCalledTimes(1);
  });

  it('launch_app takes its app identity from bundle_id/name args without a driver lookup', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('launch_app'));
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'mcp__cua-driver__launch_app',
      { bundle_id: 'com.apple.TextEdit', name: 'TextEdit' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({
      name: 'TextEdit',
      bundleId: 'com.apple.TextEdit',
    });
    expect(mcpClientState.callTool).not.toHaveBeenCalled();
  });

  it('launch_app without bundle_id/name fails closed', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('launch_app'));
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('mcp__cua-driver__launch_app', {}, { sessionId: 's1' });
    expect(result.success).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
    expect(String(result.error)).toContain('bundle_id');
  });

  it('treats an unlisted cua tool name as an app action (fail closed)', async () => {
    resolverState.getDefinition.mockReturnValue(cuaActionDefinition('exotic_future_tool'));
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute('mcp__cua-driver__exotic_future_tool', {}, { sessionId: 's1' });
    expect(result.success).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(resolverState.execute).not.toHaveBeenCalled();
  });

  it('non-cua tools keep the existing extractComputerTargetApp behaviour', async () => {
    resolverState.getDefinition.mockReturnValue({
      name: 'computer_use',
      description: 'computer',
      inputSchema: { type: 'object', properties: {}, required: [] },
      requiresPermission: true,
      permissionLevel: 'execute' as const,
    });
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executor = new ToolExecutor({ requestPermission, workingDirectory: '/tmp/workbench' });
    const result = await executor.execute(
      'computer_use',
      { action: 'click', targetApp: 'Notes' },
      { sessionId: 's1' },
    );
    expect(result.success).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls[0][0].details.targetApp).toEqual({ name: 'Notes' });
    expect(mcpClientState.callTool).not.toHaveBeenCalled();
  });
});
