// ============================================================================
// B1 第 4 档「只读探索」（readOnly）判定链测试
// ============================================================================
// 覆盖：读直通 / 写确认 / 执行确认 / classifier deny 不降级 / 会话级档解析。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from '../../../src/shared/contract';

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

  it('用户拒绝确认时写操作不执行', async () => {
    getPermissionModeManager().setMode('readOnly');
    permissionReturn = false;
    setMockTool({ name: 'write_file', requiresPermission: true, permissionLevel: 'write' });
    const result = await executor.execute('write_file', { file_path: '/test/directory/a.txt', content: 'x' }, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Permission denied');
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
});
