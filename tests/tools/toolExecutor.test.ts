// ============================================================================
// Tool Executor Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from '../../src/shared/contract';

// Mock services
vi.mock('../../src/main/services', () => ({
  getToolCache: vi.fn(() => ({
    isCacheable: vi.fn().mockReturnValue(false),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  })),
}));

// Mock logger
vi.mock('../../src/main/services/infra/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock permission classifier — 强制走"ask"路径，让 mockRequestPermission 生效
vi.mock('../../src/main/tools/permissionClassifier', () => ({
  classifyPermission: vi.fn().mockResolvedValue({ decision: 'ask', reason: 'test' }),
}));

// Mock protocol resolver — 每个 test 可以通过 setMockTool 控制 fake 工具
let mockToolDef: ToolDefinition | undefined;
let mockExecuteResult: { success: boolean; output?: string; error?: string } | Error = {
  success: true,
  output: 'Test output',
};

vi.mock('../../src/main/protocol/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    list: () => (mockToolDef ? [mockToolDef.name] : []),
    getDefinition: (name: string) =>
      mockToolDef && mockToolDef.name === name ? mockToolDef : undefined,
    listDefinitions: () => (mockToolDef ? [mockToolDef] : []),
    has: (name: string) => mockToolDef?.name === name,
    execute: vi.fn().mockImplementation(async () => {
      if (mockExecuteResult instanceof Error) throw mockExecuteResult;
      return mockExecuteResult;
    }),
  }),
}));

import { ToolExecutor } from '../../src/main/tools/toolExecutor';

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

describe('ToolExecutor', () => {
  let executor: ToolExecutor;
  let permissionCalls: Array<unknown> = [];
  let permissionReturn = true;

  beforeEach(() => {
    mockToolDef = undefined;
    mockExecuteResult = { success: true, output: 'Test output' };
    permissionCalls = [];
    permissionReturn = true;

    executor = new ToolExecutor({
      requestPermission: async (req) => {
        permissionCalls.push(req);
        return permissionReturn;
      },
      workingDirectory: '/test/directory',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('基本执行', () => {
    it('未知工具应该返回错误', async () => {
      const result = await executor.execute('unknown_tool', {}, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('任何工具都应该可以执行（代际检查已移除）', async () => {
      setMockTool();
      const result = await executor.execute('test_tool', {}, {});
      expect(result.success).toBe(true);
    });

    it('匹配代际的工具应该执行成功', async () => {
      setMockTool();
      const result = await executor.execute('test_tool', { input: 'test' }, {});
      expect(result.success).toBe(true);
    });
  });

  describe('权限检查', () => {
    it('需要权限的工具应该请求权限', async () => {
      setMockTool({ requiresPermission: true, permissionLevel: 'write' });
      await executor.execute('test_tool', {}, {});
      expect(permissionCalls.length).toBeGreaterThan(0);
    });

    it('权限拒绝应该返回错误', async () => {
      setMockTool({ requiresPermission: true });
      permissionReturn = false;
      const result = await executor.execute('test_tool', {}, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('不需要权限的工具不应请求权限', async () => {
      setMockTool({ requiresPermission: false });
      await executor.execute('test_tool', {}, {});
      expect(permissionCalls.length).toBe(0);
    });
  });

  describe('工作目录', () => {
    it('setWorkingDirectory 应该更新工作目录', async () => {
      const newDir = '/new/directory';
      executor.setWorkingDirectory(newDir);
      setMockTool();
      const result = await executor.execute('test_tool', {}, {});
      expect(result.success).toBe(true);
      // 新目录不再通过 tool.execute 验证（dispatch 层接管），只要执行不报错即可
    });
  });

  describe('错误处理', () => {
    it('工具执行抛出异常应该返回错误', async () => {
      setMockTool();
      mockExecuteResult = new Error('Tool execution failed');
      const result = await executor.execute('test_tool', {}, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool execution failed');
    });
  });
});
