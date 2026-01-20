// ============================================================================
// Agent Orchestrator Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock electron app before importing AgentOrchestrator
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/code-agent-test'),
  },
}));

// Mock isolated-vm (causes Node version issues)
vi.mock('isolated-vm', () => ({}));

// Mock services
vi.mock('../../src/main/services', () => ({
  getSessionManager: vi.fn(() => ({
    addMessage: vi.fn().mockResolvedValue(undefined),
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

// Mock browser service
vi.mock('../../src/main/services/vision/browserService', () => ({
  getBrowserService: vi.fn(() => ({
    initialize: vi.fn(),
    close: vi.fn(),
  })),
}));

// Mock cloud config service
vi.mock('../../src/main/services/cloud/cloudConfigService', () => ({
  getCloudConfigService: vi.fn(() => ({
    getAllToolMeta: vi.fn().mockReturnValue({}),
    getToolMeta: vi.fn().mockReturnValue(undefined),
  })),
}));

import { AgentOrchestrator } from '../../src/main/agent/agentOrchestrator';
import type { GenerationManager } from '../../src/main/generation/generationManager';
import type { ConfigService } from '../../src/main/services/core/configService';

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let mockGenerationManager: GenerationManager;
  let mockConfigService: ConfigService;
  let mockOnEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock GenerationManager
    mockGenerationManager = {
      getCurrentGeneration: vi.fn().mockReturnValue({
        id: 'gen4',
        name: 'Gen 4',
        description: 'Test generation',
        systemPrompt: 'You are a test agent',
      }),
    } as unknown as GenerationManager;

    // Mock ConfigService
    mockConfigService = {
      getSettings: vi.fn().mockReturnValue({
        permissions: {
          autoApprove: {
            read: true,
            write: false,
            execute: false,
            network: false,
          },
          devModeAutoApprove: false,
        },
      }),
      getApiKey: vi.fn().mockReturnValue('test-api-key'),
    } as unknown as ConfigService;

    mockOnEvent = vi.fn();

    orchestrator = new AgentOrchestrator({
      generationManager: mockGenerationManager,
      configService: mockConfigService,
      onEvent: mockOnEvent,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Initialization Tests
  // --------------------------------------------------------------------------
  describe('初始化', () => {
    it('应该正确初始化工作目录', () => {
      const workDir = orchestrator.getWorkingDirectory();
      expect(workDir).toBeDefined();
      expect(typeof workDir).toBe('string');
    });

    it('应该创建 ToolRegistry 实例', () => {
      // ToolRegistry 是内部创建的，通过功能验证
      expect(orchestrator).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Working Directory Tests
  // --------------------------------------------------------------------------
  describe('工作目录管理', () => {
    it('setWorkingDirectory 应该更新工作目录', () => {
      const newDir = '/test/new/directory';
      orchestrator.setWorkingDirectory(newDir);
      expect(orchestrator.getWorkingDirectory()).toBe(newDir);
    });

    it('getWorkingDirectory 应该返回当前目录', () => {
      const dir = orchestrator.getWorkingDirectory();
      expect(dir).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Cancel Tests
  // --------------------------------------------------------------------------
  describe('取消任务', () => {
    it('cancel 在没有活动任务时不应抛错', async () => {
      await expect(orchestrator.cancel()).resolves.not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Permission Response Tests
  // --------------------------------------------------------------------------
  describe('权限响应处理', () => {
    it('handlePermissionResponse 对不存在的请求不应抛错', () => {
      expect(() => {
        orchestrator.handlePermissionResponse('nonexistent-id', 'allow');
      }).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Planning Service Tests
  // --------------------------------------------------------------------------
  describe('规划服务', () => {
    it('setPlanningService 应该设置规划服务', () => {
      const mockPlanningService = {} as unknown;
      expect(() => {
        orchestrator.setPlanningService(mockPlanningService as never);
      }).not.toThrow();
    });
  });
});
