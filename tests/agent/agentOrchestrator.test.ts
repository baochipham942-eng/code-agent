// ============================================================================
// Agent Orchestrator Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const browserMocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    close: vi.fn(),
    listTabs: vi.fn(() => []),
    getSessionState: vi.fn(() => ({
      isRunning: false,
      profileId: 'test-browser-profile',
      profileDir: '/tmp/code-agent-test/browser-profile',
      tabs: [],
    })),
    logger: {
      log: vi.fn(),
      getLogsAsString: vi.fn(() => ''),
    },
    beginTrace: vi.fn(() => ({})),
    finishTrace: vi.fn((trace: Record<string, unknown>) => trace),
  };
  return { service };
});

const loggerMocks = vi.hoisted(() => {
  const createMockLogger = () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  });

  return {
    logger: createMockLogger(),
    createLogger: vi.fn(() => createMockLogger()),
    LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  };
});

const logCollectorMocks = vi.hoisted(() => {
  const createMockLogCollector = () => ({
    log: vi.fn(),
    browser: vi.fn(),
    agent: vi.fn(),
    tool: vi.fn(),
    getLogs: vi.fn(() => []),
    getAllLogs: vi.fn(() => []),
    getLogsAsString: vi.fn(() => ''),
    getAllLogsAsString: vi.fn(() => ''),
    getStatus: vi.fn(() => ({
      browserLogs: 0,
      agentLogs: 0,
      toolLogs: 0,
      totalLogs: 0,
      persistenceEnabled: false,
    })),
    clear: vi.fn(),
    clearAll: vi.fn(),
    close: vi.fn(),
  });

  return {
    logCollector: createMockLogCollector(),
    createLogCollector: vi.fn(() => createMockLogCollector()),
  };
});

const configServiceMocks = vi.hoisted(() => {
  const settings = {
    models: {
      default: 'openai',
      providers: {
        openai: { enabled: true },
      },
      routing: {},
    },
    permissions: {
      autoApprove: {
        read: true,
        write: false,
        execute: false,
        network: false,
      },
      devModeAutoApprove: false,
    },
    connectors: {
      enabledNative: [],
    },
  };

  const service = {
    getSettings: vi.fn(() => settings),
    getApiKey: vi.fn(() => ''),
    getServiceApiKey: vi.fn(() => ''),
    getIntegration: vi.fn(() => undefined),
    getModelForCapability: vi.fn(() => undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };

  return {
    isProduction: vi.fn(() => false),
    sanitizeForLogging: vi.fn((value: unknown) => value),
    safeLog: vi.fn(),
    ConfigService: vi.fn(() => service),
    initConfigService: vi.fn(() => service),
    getConfigService: vi.fn(() => service),
  };
});

// Mock electron app before importing AgentOrchestrator
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/code-agent-test'),
  },
}));

// Mock services
vi.mock('../../src/main/services', () => ({
  getSessionManager: vi.fn(() => ({
    addMessage: vi.fn().mockResolvedValue(undefined),
    getCurrentSessionId: vi.fn().mockReturnValue('test-session-id'),
  })),
}));

// Mock logger
vi.mock('../../src/main/services/infra/logger', () => loggerMocks);
vi.mock('../../src/main/services/infra/logger.js', () => loggerMocks);

vi.mock('../../src/main/mcp/logCollector', () => logCollectorMocks);
vi.mock('../../src/main/mcp/logCollector.js', () => logCollectorMocks);

vi.mock('../../src/main/services/core/configService', () => configServiceMocks);
vi.mock('../../src/main/services/core/configService.js', () => configServiceMocks);

// Mock browser service at the actual infra layer used by ToolExecutor imports.
vi.mock('../../src/main/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
  BrowserService: vi.fn(() => browserMocks.service),
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => params,
}));

vi.mock('../../src/main/services/infra/browserPool.js', () => ({
  browserPool: {
    acquire: vi.fn(() => browserMocks.service),
  },
  getBrowserService: vi.fn(() => browserMocks.service),
}));

// Mock cloud config service
vi.mock('../../src/main/services/cloud/cloudConfigService', () => ({
  getCloudConfigService: vi.fn(() => ({
    getAllToolMeta: vi.fn().mockReturnValue({}),
    getToolMeta: vi.fn().mockReturnValue(undefined),
  })),
}));

import { AgentOrchestrator } from '../../src/main/agent/agentOrchestrator';
import type { ConfigService } from '../../src/main/services/core/configService';

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let mockConfigService: ConfigService;
  let mockOnEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
