// ============================================================================
// B1 第 4 档「只读探索」（readOnly）判定链测试
// ============================================================================
// 覆盖：读直通 / 写确认 / 执行确认 / classifier deny 不降级 / 会话级档解析。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import type { ToolDefinition } from '../../../src/shared/contract';

// 会话档持久化落 CODE_AGENT_DATA_DIR：测试指到临时目录，不污染真实用户目录。
const tmpDataDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1-readonly-'));
process.env.CODE_AGENT_DATA_DIR = tmpDataDir;
afterAll(() => {
  delete process.env.CODE_AGENT_DATA_DIR;
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

// Mock logger
vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: vi.fn(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

// Mock permission classifier — 每个用例可控（默认 approve，模拟"项目内写入自动放行"）
let mockClassification: { decision: 'approve' | 'deny' | 'ask'; reason: string; confidence: number; cached: boolean } = {
  decision: 'approve',
  reason: 'test auto-approve',
  confidence: 1,
  cached: false,
};
vi.mock('../../../src/host/tools/permissionClassifier', () => ({
  classifyPermission: vi.fn(async () => mockClassification),
}));

// Mock protocol resolver — 通过 setMockTool 控制 fake 工具
let mockToolDef: ToolDefinition | undefined;
vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    list: () => (mockToolDef ? [mockToolDef.name] : []),
    getDefinition: (name: string) =>
      mockToolDef && mockToolDef.name === name ? mockToolDef : undefined,
    listDefinitions: () => (mockToolDef ? [mockToolDef] : []),
    has: (name: string) => mockToolDef?.name === name,
    execute: vi.fn().mockResolvedValue({ success: true, output: 'ok' }),
  }),
}));

import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import { createCLIPermissionHandler } from '../../../src/cli/permissionPolicy';
import {
  getPermissionModeManager,
  resetPermissionModeManager,
} from '../../../src/host/permissions/modes';

function setMockTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const def: ToolDefinition = {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
    ...overrides,
  };
  mockToolDef = def;
  return def;
}

describe('readOnly 只读探索档', () => {
  let executor: ToolExecutor;
  let permissionCalls: Array<Record<string, unknown>> = [];
  let permissionReturn = true;

  beforeEach(() => {
    resetPermissionModeManager();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
    mockToolDef = undefined;
    mockClassification = { decision: 'approve', reason: 'test auto-approve', confidence: 1, cached: false };
    permissionCalls = [];
    permissionReturn = true;
    executor = new ToolExecutor({
      requestPermission: async (req) => {
        permissionCalls.push(req as unknown as Record<string, unknown>);
        return permissionReturn;
      },
      workingDirectory: '/test/directory',
    });
  });

  afterEach(() => {
    resetPermissionModeManager();
    vi.clearAllMocks();
  });

  it('读类工具（requiresPermission=false）直通，不请求确认', async () => {
    getPermissionModeManager().setMode('readOnly');
    setMockTool({ requiresPermission: false, permissionLevel: 'read' });
    const result = await executor.execute('test_tool', {}, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(0);
  });

  it('写工具即使 classifier 自动放行也必须用户确认', async () => {
    getPermissionModeManager().setMode('readOnly');
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
  });

  it('对照组：default 档下同一写工具被 classifier 自动放行，不请求确认', async () => {
    // 全局默认档（default）
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(0);
  });

  it('bash 已知安全命令（白名单捷径）在 readOnly 下也必须确认', async () => {
    getPermissionModeManager().setMode('readOnly');
    setMockTool({ name: 'bash', requiresPermission: true, permissionLevel: 'execute' });
    const result = await executor.execute('bash', { command: 'ls -la' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
  });

  it('对照组：default 档下 bash 已知安全命令跳过确认', async () => {
    setMockTool({ name: 'bash', requiresPermission: true, permissionLevel: 'execute' });
    const result = await executor.execute('bash', { command: 'ls -la' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(0);
  });

  it('用户拒绝确认时写操作不执行，错误说明 readOnly 拦截与出路（审出 MED）', async () => {
    getPermissionModeManager().setMode('readOnly');
    permissionReturn = false;
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('只读探索模式');
    expect(result.error).toContain('切换会话权限档');
  });

  it('classifier deny 在 readOnly 下保持 deny，不降级为确认', async () => {
    getPermissionModeManager().setMode('readOnly');
    mockClassification = { decision: 'deny', reason: 'dangerous', confidence: 1, cached: false };
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/etc/passwd', content: 'x' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied');
    expect(permissionCalls.length).toBe(0);
  });

  it('会话级档解析：仅设置了 readOnly 的会话要求确认，其他会话不受影响', async () => {
    // 全局 default，session A 切到 readOnly
    getPermissionModeManager().setSessionMode('session-a', 'readOnly');
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });

    const resultA = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, { sessionId: 'session-a' });
    expect(resultA.success).toBe(true);
    expect(permissionCalls.length).toBe(1);

    const resultB = await executor.execute('write_file', { file_path: '/test/directory/b.txt', content: 'x' }, { sessionId: 'session-b' });
    expect(resultB.success).toBe(true);
    expect(permissionCalls.length).toBe(1); // session B 走 classifier 自动放行，没有新增确认
  });

  it('readOnly 下权限请求带 forceConfirm：终审层自动放行捷径（autoApprove/权限记忆）全部失效（审出 HIGH）', async () => {
    getPermissionModeManager().setMode('readOnly');
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
    // forceConfirm=true 是终审层承诺兑现的锚点：
    // agentOrchestrator 的 devModeAutoApprove/autoApprove[level] 与
    // renderer PermissionCard 的 always/session 权限记忆都以 !forceConfirm 为前提。
    expect(permissionCalls[0].forceConfirm).toBe(true);
  });

  it('对照组：default 档下用户确认请求不带 forceConfirm（自动放行捷径照常可用）', async () => {
    mockClassification = { decision: 'ask', reason: 'needs user', confidence: 1, cached: false };
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
    expect(permissionCalls[0].forceConfirm).not.toBe(true);
  });

  it('network 档非只读工具（无 annotations 的 MCP 兜底）在 readOnly 下强制确认（审出 HIGH）', async () => {
    getPermissionModeManager().setMode('readOnly');
    mockClassification = { decision: 'ask', reason: 'mcp default ask', confidence: 1, cached: false };
    // 模拟 mcpToolRegistry 兜底产物：requiresPermission=true, network, readOnly 未证明
    setMockTool({ name: 'mcp__github__create_issue', requiresPermission: true, permissionLevel: 'network', readOnly: false });
    const result = await executor.execute('mcp__github__create_issue', { title: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
    expect(permissionCalls[0].forceConfirm).toBe(true); // 终审层放行捷径全部失效
  });

  it('network 档只读工具（webSearch 类，readOnly=true）在 readOnly 下直通', async () => {
    getPermissionModeManager().setMode('readOnly');
    setMockTool({ name: 'web_search', requiresPermission: true, permissionLevel: 'network', readOnly: true });
    const result = await executor.execute('web_search', { query: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(0); // classifier approve 照常放行，不强制确认
  });

  it('生产 web 聊天路径（CLI 非交互 handler）：readOnly 下 MCP 网络变更工具被自动拒绝而非静默放行（审出 HIGH）', async () => {
    getPermissionModeManager().setMode('readOnly');
    mockClassification = { decision: 'ask', reason: 'mcp default ask', confidence: 1, cached: false };
    const warnings: string[] = [];
    const cliExecutor = new ToolExecutor({
      requestPermission: createCLIPermissionHandler({ warn: (m) => warnings.push(m) }),
      workingDirectory: '/test/directory',
    });
    setMockTool({ name: 'mcp__github__create_issue', requiresPermission: true, permissionLevel: 'network', readOnly: false });
    const result = await cliExecutor.execute('mcp__github__create_issue', { title: 'x' }, {});
    expect(result.success).toBe(false); // fail-closed：不是修复前的静默执行
    expect(result.error).toContain('只读探索模式');
    expect(warnings.length).toBe(1);
  });

  it('生产 web 聊天路径（CLI 非交互 handler）：readOnly 下写入自动拒绝且错误可转述（审出 MED）', async () => {
    getPermissionModeManager().setMode('readOnly');
    const cliExecutor = new ToolExecutor({
      requestPermission: createCLIPermissionHandler({ warn: () => {} }),
      workingDirectory: '/test/directory',
    });
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await cliExecutor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('只读探索模式');
    expect(result.error).toContain('切换会话权限档');
  });
});

describe('acceptEdits / bypassPermissions 档位判定链（审出 MED：曾是虚标档）', () => {
  let executor: ToolExecutor;
  let permissionCalls: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    resetPermissionModeManager();
    fs.rmSync(nodePath.join(tmpDataDir, 'session-permission-modes.json'), { force: true });
    mockToolDef = undefined;
    // classifier 判 ask：默认档下会走用户确认，免确认档应升级为自动放行
    mockClassification = { decision: 'ask', reason: 'needs user', confidence: 1, cached: false };
    permissionCalls = [];
    executor = new ToolExecutor({
      requestPermission: async (req) => {
        permissionCalls.push(req as unknown as Record<string, unknown>);
        return true;
      },
      workingDirectory: '/test/directory',
    });
  });

  afterEach(() => {
    resetPermissionModeManager();
    vi.clearAllMocks();
  });

  it('acceptEdits：写入免确认（classifier ask 升级为自动放行）', async () => {
    getPermissionModeManager().setMode('acceptEdits');
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(0);
  });

  it('acceptEdits：执行档不免确认，照走用户确认', async () => {
    getPermissionModeManager().setMode('acceptEdits');
    setMockTool({ name: 'run_thing', requiresPermission: true, permissionLevel: 'execute' });
    const result = await executor.execute('run_thing', {}, {});
    expect(result.success).toBe(true);
    expect(permissionCalls.length).toBe(1);
  });

  it('bypassPermissions：写入与执行都免确认', async () => {
    getPermissionModeManager().setMode('bypassPermissions', true);
    setMockTool({ name: 'run_thing', requiresPermission: true, permissionLevel: 'execute' });
    expect((await executor.execute('run_thing', {}, {})).success).toBe(true);
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    expect((await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {})).success).toBe(true);
    expect(permissionCalls.length).toBe(0);
  });

  it('bypassPermissions：classifier deny 不放宽，硬毙照常', async () => {
    getPermissionModeManager().setMode('bypassPermissions', true);
    mockClassification = { decision: 'deny', reason: 'dangerous', confidence: 1, cached: false };
    setMockTool({ name: 'run_thing', requiresPermission: true, permissionLevel: 'execute' });
    const result = await executor.execute('run_thing', {}, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Denied');
    expect(permissionCalls.length).toBe(0);
  });

  it('permissionModeOverride：父会话 bypass 时被收缩的 subagent 不能借会话档扩权', async () => {
    getPermissionModeManager().setMode('bypassPermissions', true); // 父会话档 = bypass
    const narrowedExecutor = new ToolExecutor({
      requestPermission: async (req) => {
        permissionCalls.push(req as unknown as Record<string, unknown>);
        return false; // subagent 非交互：保守拒绝
      },
      workingDirectory: '/test/directory',
      permissionModeOverride: 'default', // 父子收缩后的 effectiveMode
    });
    setMockTool({ name: 'run_thing', requiresPermission: true, permissionLevel: 'execute' });
    const result = await narrowedExecutor.execute('run_thing', {}, {});
    expect(result.success).toBe(false); // 不因会话档 bypass 而自动放行
    expect(permissionCalls.length).toBe(1);
  });
});
