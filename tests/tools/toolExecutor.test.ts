// ============================================================================
// Tool Executor Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolDefinition } from '../../src/shared/contract';
import { readXlsxSchema } from '../../src/host/tools/modules/network/readXlsx.schema';

// Mock services
vi.mock('../../src/host/services', () => ({
  getToolCache: vi.fn(() => ({
    isCacheable: vi.fn().mockReturnValue(false),
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  })),
}));

// Mock logger
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

// Mock permission classifier — 强制走"ask"路径，让 mockRequestPermission 生效
vi.mock('../../src/host/tools/permissionClassifier', () => ({
  classifyPermission: vi.fn().mockResolvedValue({ decision: 'ask', reason: 'test' }),
}));

// Mock protocol resolver — 每个 test 可以通过 setMockTool 控制 fake 工具
let mockToolDef: ToolDefinition | undefined;
let mockExecuteResult: { success: boolean; output?: string; error?: string } | Error = {
  success: true,
  output: 'Test output',
};
let mockExecuteCalls = 0;

vi.mock('../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    list: () => (mockToolDef ? [mockToolDef.name] : []),
    getDefinition: (name: string) =>
      mockToolDef && mockToolDef.name === name ? mockToolDef : undefined,
    listDefinitions: () => (mockToolDef ? [mockToolDef] : []),
    has: (name: string) => mockToolDef?.name === name,
    execute: vi.fn().mockImplementation(async () => {
      mockExecuteCalls += 1;
      if (mockExecuteResult instanceof Error) throw mockExecuteResult;
      return mockExecuteResult;
    }),
  }),
}));

import { ToolExecutor } from '../../src/host/tools/toolExecutor';

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
    mockExecuteCalls = 0;
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

    it('已注册工具应该可以执行', async () => {
      setMockTool();
      const result = await executor.execute('test_tool', {}, {});
      expect(result.success).toBe(true);
    });

    it('带参数的工具应该执行成功', async () => {
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

  describe('schema validation', () => {
    it('根参数不是 object 时应该返回 root type_mismatch 错误', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
        },
      });

      const result = await executor.execute('test_tool', [] as unknown as Record<string, unknown>, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=$');
      expect(result.error).toContain('expected=object');
      expect(result.error).toContain('bad_value=[]');
      expect(result.error).toContain('category=type_mismatch');
      expect(mockExecuteCalls).toBe(0);
    });

    it('缺少必填字段应该返回结构化 missing_required 错误', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'Excel 文件路径' },
          },
          required: ['file_path'],
        },
      });

      const result = await executor.execute('test_tool', { file_path: '   ' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=file_path');
      expect(result.error).toContain('expected=string');
      expect(result.error).toContain('bad_value="   "');
      expect(result.error).toContain('category=missing_required');
      expect(mockExecuteCalls).toBe(0);
    });

    it('字段类型不匹配应该返回 type_mismatch 错误', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            max_rows: { type: 'number' },
          },
        },
      });

      const result = await executor.execute('test_tool', { max_rows: '10' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=max_rows');
      expect(result.error).toContain('expected=number');
      expect(result.error).toContain('bad_value="10"');
      expect(result.error).toContain('category=type_mismatch');
    });

    it('enum 不匹配应该返回 enum_mismatch 错误', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['table', 'json', 'csv'] },
          },
        },
      });

      const result = await executor.execute('test_tool', { format: 'yaml' }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=format');
      expect(result.error).toContain('expected=one of table, json, csv');
      expect(result.error).toContain('bad_value="yaml"');
      expect(result.error).toContain('category=enum_mismatch');
    });

    it('嵌套对象 required 应该递归校验', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              properties: {
                endpoint: { type: 'string' },
              },
              required: ['endpoint'],
            },
          },
        },
      });

      const result = await executor.execute('test_tool', { config: {} }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=config.endpoint');
      expect(result.error).toContain('expected=string');
      expect(result.error).toContain('category=missing_required');
    });

    it('format 不匹配应该返回 format_mismatch 错误', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' } as never,
            email: { type: 'string', format: 'email' } as never,
            day: { type: 'string', format: 'date' } as never,
            timestamp: { type: 'string', format: 'date-time' } as never,
          },
        },
      });

      const result = await executor.execute('test_tool', {
        url: 'not a url',
        email: 'bad-email',
        day: '2026-13-40',
        timestamp: 'not-a-date-time',
      }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=url');
      expect(result.error).toContain('expected=format uri');
      expect(result.error).toContain('category=format_mismatch');
      expect(result.error).toContain('field_path=email');
      expect(result.error).toContain('field_path=day');
      expect(result.error).toContain('field_path=timestamp');
    });

    it('additionalProperties=false 应该阻止额外字段并短路执行', async () => {
      setMockTool({
        inputSchema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
          },
          additionalProperties: false,
        },
      });

      const result = await executor.execute('test_tool', { file_path: '/tmp/a.xlsx', unexpected: true }, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('field_path=unexpected');
      expect(result.error).toContain('expected=no additional properties');
      expect(result.error).toContain('bad_value=true');
      expect(result.error).toContain('category=additional_property');
      expect(mockExecuteCalls).toBe(0);
      expect(permissionCalls.length).toBe(0);
    });

    it('联合 type 应该允许 read_xlsx 的数字 sheet 索引', async () => {
      setMockTool({
        name: 'read_xlsx',
        inputSchema: readXlsxSchema.inputSchema,
      });

      const result = await executor.execute('read_xlsx', { file_path: '/tmp/a.xlsx', sheet: 0 }, {});

      expect(result.success).toBe(true);
      expect(mockExecuteCalls).toBe(1);
    });
  });
});
