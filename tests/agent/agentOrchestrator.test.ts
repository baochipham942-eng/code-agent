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
vi.mock('../../src/host/services', () => ({
  getSessionManager: vi.fn(() => ({
    addMessage: vi.fn().mockResolvedValue(undefined),
    getCurrentSessionId: vi.fn().mockReturnValue('test-session-id'),
  })),
}));

// Mock logger
vi.mock('../../src/host/services/infra/logger', () => loggerMocks);
vi.mock('../../src/host/services/infra/logger.js', () => loggerMocks);

vi.mock('../../src/host/mcp/logCollector', () => logCollectorMocks);
vi.mock('../../src/host/mcp/logCollector.js', () => logCollectorMocks);

vi.mock('../../src/host/services/core/configService', () => configServiceMocks);
vi.mock('../../src/host/services/core/configService.js', () => configServiceMocks);

// Mock browser service at the actual infra layer used by ToolExecutor imports.
vi.mock('../../src/host/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
  BrowserService: vi.fn(() => browserMocks.service),
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => params,
}));

vi.mock('../../src/host/services/infra/browserPool.js', () => ({
  browserPool: {
    acquire: vi.fn(() => browserMocks.service),
  },
  getBrowserService: vi.fn(() => browserMocks.service),
}));

// Mock cloud config service
vi.mock('../../src/host/services/cloud/cloudConfigService', () => ({
  getCloudConfigService: vi.fn(() => ({
    getAllToolMeta: vi.fn().mockReturnValue({}),
    getToolMeta: vi.fn().mockReturnValue(undefined),
  })),
}));

import { AgentOrchestrator } from '../../src/host/agent/agentOrchestrator';
import type { ConfigService } from '../../src/host/services/core/configService';
import type { AgentEvent, Message } from '../../src/shared/contract';

// 部分目标是 private 方法 / 内部状态，特征测试经类型逃逸访问（测试专用）
interface OrchestratorInternals {
  applyHistoryVisibility(message: Message, options?: { historyVisibility?: 'meta' | 'normal' }): Message;
  resolveExplicitAgentRouting(agentId: string): { agent: unknown; score: number; reason: string } | null;
  resolveTurnRouting(content: string, sessionId?: string, agentOverrideId?: string): Promise<{
    resolution: { agent: { id: string; name: string }; score: number; reason: string } | null;
    requestedAgentId?: string;
  }>;
  agentLoop: { steer: ReturnType<typeof vi.fn> } | null;
  pendingSteerMessages: unknown[];
  pendingPermissions: Map<string, { resolve: (r: string) => void }>;
}
function internals(o: AgentOrchestrator): OrchestratorInternals {
  return o as unknown as OrchestratorInternals;
}
function makeMessage(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: 0 };
}

describe('AgentOrchestrator', () => {
  let orchestrator: AgentOrchestrator;
  let mockConfigService: ConfigService;
  let mockOnEvent: ReturnType<typeof vi.fn<(event: AgentEvent) => void>>;

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

  describe('调整方向', () => {
    it('传播 steer 持久化错误，并在失败后复位 interrupt 状态', async () => {
      const steer = vi.fn()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(undefined);
      internals(orchestrator).agentLoop = { steer };

      await expect(orchestrator.interruptAndContinue('first direction')).rejects.toThrow('disk full');
      expect(mockOnEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt_complete' }));

      await expect(orchestrator.interruptAndContinue('second direction')).resolves.toBeUndefined();
      expect(steer).toHaveBeenCalledTimes(2);
      expect(internals(orchestrator).pendingSteerMessages).toHaveLength(0);
      expect(mockOnEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt_complete' }));
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

  // --------------------------------------------------------------------------
  // Delegate 模式 / Plan 审批开关
  // --------------------------------------------------------------------------
  describe('委托模式与计划审批开关', () => {
    it('delegate 模式默认关闭，可切换', () => {
      expect(orchestrator.isDelegateMode()).toBe(false);
      orchestrator.setDelegateMode(true);
      expect(orchestrator.isDelegateMode()).toBe(true);
      orchestrator.setDelegateMode(false);
      expect(orchestrator.isDelegateMode()).toBe(false);
    });

    it('计划审批默认不要求，可切换', () => {
      expect(orchestrator.isRequirePlanApproval()).toBe(false);
      orchestrator.setRequirePlanApproval(true);
      expect(orchestrator.isRequirePlanApproval()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // isProcessing
  // --------------------------------------------------------------------------
  describe('isProcessing', () => {
    it('无活动 agentLoop / research 时返回 false', () => {
      expect(orchestrator.isProcessing()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 默认工作目录标记
  // --------------------------------------------------------------------------
  describe('默认工作目录标记', () => {
    it('初始使用默认目录，setWorkingDirectory 后翻转为 false', () => {
      expect(orchestrator.isUsingDefaultWorkingDirectory()).toBe(true);
      orchestrator.setWorkingDirectory('/test/explicit/dir');
      expect(orchestrator.isUsingDefaultWorkingDirectory()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 调研用户设置（部分合并）
  // --------------------------------------------------------------------------
  describe('调研用户设置', () => {
    it('setResearchUserSettings 浅合并，不覆盖未传字段', () => {
      orchestrator.setResearchUserSettings({ searchEngine: 'tavily' } as never);
      orchestrator.setResearchUserSettings({ maxResults: 5 } as never);
      const settings = orchestrator.getResearchUserSettings() as Record<string, unknown>;
      expect(settings.searchEngine).toBe('tavily'); // 第一次的值保留
      expect(settings.maxResults).toBe(5);
    });

    it('getResearchUserSettings 返回副本，外部修改不污染内部', () => {
      orchestrator.setResearchUserSettings({ searchEngine: 'tavily' } as never);
      const snapshot = orchestrator.getResearchUserSettings() as Record<string, unknown>;
      snapshot.searchEngine = 'mutated';
      expect((orchestrator.getResearchUserSettings() as Record<string, unknown>).searchEngine).toBe('tavily');
    });
  });

  // --------------------------------------------------------------------------
  // 消息状态防御性拷贝
  // --------------------------------------------------------------------------
  describe('消息状态防御性拷贝', () => {
    it('setMessages 存入副本，外部修改源数组不影响内部', () => {
      const source = [makeMessage('m1', 'user', 'hello')];
      orchestrator.setMessages(source);
      source.push(makeMessage('m2', 'user', 'injected'));
      expect(orchestrator.getMessages()).toHaveLength(1);
    });

    it('getMessages 返回副本，修改返回值不影响内部', () => {
      orchestrator.setMessages([makeMessage('m1', 'user', 'hello')]);
      const returned = orchestrator.getMessages();
      returned.push(makeMessage('m2', 'user', 'injected'));
      expect(orchestrator.getMessages()).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // 权限响应：resolve 并清除挂起项
  // --------------------------------------------------------------------------
  describe('权限响应解除挂起', () => {
    it('handlePermissionResponse 对已登记的挂起项 resolve 并从队列移除', () => {
      const resolve = vi.fn();
      internals(orchestrator).pendingPermissions.set('req-1', { resolve });
      orchestrator.handlePermissionResponse('req-1', 'allow');
      expect(resolve).toHaveBeenCalledWith('allow');
      expect(internals(orchestrator).pendingPermissions.has('req-1')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // applyHistoryVisibility（private）
  // --------------------------------------------------------------------------
  describe('applyHistoryVisibility', () => {
    it('historyVisibility=meta 时标记 isMeta 并兜底 source=system', () => {
      const message = makeMessage('m1', 'user', 'x');
      const out = internals(orchestrator).applyHistoryVisibility(message, { historyVisibility: 'meta' });
      expect(out.isMeta).toBe(true);
      expect(out.source).toBe('system');
    });

    it('meta 时已有 source 不被覆盖', () => {
      const message: Message = { ...makeMessage('m1', 'user', 'x'), source: 'user' };
      const out = internals(orchestrator).applyHistoryVisibility(message, { historyVisibility: 'meta' });
      expect(out.source).toBe('user');
    });

    it('非 meta 时消息原样返回，不加 isMeta', () => {
      const message = makeMessage('m1', 'user', 'x');
      const out = internals(orchestrator).applyHistoryVisibility(message, { historyVisibility: 'normal' });
      expect(out.isMeta).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // resolveExplicitAgentRouting（private）—— 未知 id 优雅兜底
  // --------------------------------------------------------------------------
  describe('resolveExplicitAgentRouting', () => {
    it('未知 agentId 不抛错，返回 null（回落到自动路由）', () => {
      const result = internals(orchestrator).resolveExplicitAgentRouting('__nonexistent_agent_xyz__');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // resolveTurnRouting（private）—— 显式选择的 requestedAgentId 必须保留，
  // 静默兜底（`?? resolveAgentRouting`）改为可判定的降级信号来源
  // --------------------------------------------------------------------------
  describe('resolveTurnRouting', () => {
    it('显式命中 → resolution 来自显式选择且 requestedAgentId 保留', async () => {
      const out = await internals(orchestrator).resolveTurnRouting('随便看看代码', undefined, 'explore');
      expect(out.requestedAgentId).toBe('explore');
      expect(out.resolution?.agent.id).toBe('explore');
    });

    it('显式解析失败 → requestedAgentId 保留（降级不再静默）', async () => {
      const out = await internals(orchestrator).resolveTurnRouting('hello', undefined, '__nonexistent_agent_xyz__');
      expect(out.requestedAgentId).toBe('__nonexistent_agent_xyz__');
      // 自动路由兜底：命中与否都不允许丢失 requestedAgentId
      expect(out.resolution?.agent.id).not.toBe('__nonexistent_agent_xyz__');
    });

    it('无显式选择 → requestedAgentId 不出现', async () => {
      const out = await internals(orchestrator).resolveTurnRouting('hello', undefined, undefined);
      expect(out.requestedAgentId).toBeUndefined();
    });

    it('agentOverrideId 带空白 → 规整后不产生假降级（requestedAgentId === 实际 agent id）', async () => {
      const out = await internals(orchestrator).resolveTurnRouting('看代码', undefined, '  explore  ');
      expect(out.requestedAgentId).toBe('explore');
      expect(out.resolution?.agent.id).toBe('explore');
    });

    it('agentOverrideId 全空白 → 视同无显式选择', async () => {
      const out = await internals(orchestrator).resolveTurnRouting('hello', undefined, '   ');
      expect(out.requestedAgentId).toBeUndefined();
    });
  });
});
