// ============================================================================
// Tool Executor Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { ToolExecutor } from '../../src/main/tools/toolExecutor';
import type { ToolRegistry, Tool } from '../../src/main/tools/toolRegistry';

describe('ToolExecutor', () => {
  let executor: ToolExecutor;
  let mockToolRegistry: ToolRegistry;
  let mockRequestPermission: ReturnType<typeof vi.fn>;

  const createMockTool = (overrides: Partial<Tool> = {}): Tool => ({
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    generations: ['gen1', 'gen2', 'gen3', 'gen4'],
    requiresPermission: false,
    permissionLevel: 'read',
    execute: vi.fn().mockResolvedValue({ success: true, output: 'Test output' }),
    ...overrides,
  });

  beforeEach(() => {
    mockRequestPermission = vi.fn().mockResolvedValue(true);

    mockToolRegistry = {
      get: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      getForGeneration: vi.fn().mockReturnValue([]),
      register: vi.fn(),
      unregister: vi.fn(),
      getToolDefinitions: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    executor = new ToolExecutor({
      toolRegistry: mockToolRegistry,
      requestPermission: mockRequestPermission,
      workingDirectory: '/test/directory',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Basic Execution Tests
  // --------------------------------------------------------------------------
  describe('基本执行', () => {
    it('未知工具应该返回错误', async () => {
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const result = await executor.execute('unknown_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });

    it('不匹配代际的工具应该返回错误', async () => {
      const tool = createMockTool({ generations: ['gen1'] });
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      const result = await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');
    });

    it('匹配代际的工具应该执行成功', async () => {
      const tool = createMockTool();
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      const result = await executor.execute('test_tool', { input: 'test' }, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(result.success).toBe(true);
      expect(tool.execute).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Permission Tests
  // --------------------------------------------------------------------------
  describe('权限检查', () => {
    it('需要权限的工具应该请求权限', async () => {
      const tool = createMockTool({ requiresPermission: true, permissionLevel: 'write' });
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(mockRequestPermission).toHaveBeenCalled();
    });

    it('权限拒绝应该返回错误', async () => {
      const tool = createMockTool({ requiresPermission: true });
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);
      mockRequestPermission.mockResolvedValue(false);

      const result = await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('不需要权限的工具不应请求权限', async () => {
      const tool = createMockTool({ requiresPermission: false });
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(mockRequestPermission).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Working Directory Tests
  // --------------------------------------------------------------------------
  describe('工作目录', () => {
    it('setWorkingDirectory 应该更新工作目录', async () => {
      const newDir = '/new/directory';
      executor.setWorkingDirectory(newDir);
      // 通过执行工具验证 context 中的 workingDirectory
      const tool = createMockTool();
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(tool.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workingDirectory: newDir })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Error Handling Tests
  // --------------------------------------------------------------------------
  describe('错误处理', () => {
    it('工具执行抛出异常应该返回错误', async () => {
      const tool = createMockTool({
        execute: vi.fn().mockRejectedValue(new Error('Tool execution failed')),
      });
      (mockToolRegistry.get as ReturnType<typeof vi.fn>).mockReturnValue(tool);

      const result = await executor.execute('test_tool', {}, {
        generation: { id: 'gen4', name: 'Gen 4' } as never,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Tool execution failed');
    });
  });
});
