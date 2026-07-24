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

const queuedInputMocks = vi.hoisted(() => ({
  db: {},
  enqueue: vi.fn(),
  getDb: vi.fn(),
}));

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

vi.mock('../../src/host/services/core/databaseService', () => ({
  getDatabase: vi.fn(() => ({ getDb: queuedInputMocks.getDb })),
}));

vi.mock('../../src/host/services/core/repositories/QueuedInputRepository', () => ({
  QueuedInputRepository: class {
    enqueue = queuedInputMocks.enqueue;
  },
}));

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
import { getPermissionModeManager } from '../../src/host/permissions/modes';
import { approvalParkEvents } from '../../src/host/agent/approvalParkEvents';
import type { PendingApprovalRepository } from '../../src/host/services/core/repositories/PendingApprovalRepository';
import { SteerRejectedError } from '../../src/host/agent/runtime/conversationRuntime';
import type { ConfigService } from '../../src/host/services/core/configService';
import type { AgentEvent, Message, MessageAttachment } from '../../src/shared/contract';
import type { AgentRunOptions } from '../../src/host/research/types';

// 部分目标是 private 方法 / 内部状态，特征测试经类型逃逸访问（测试专用）
interface OrchestratorInternals {
  applyHistoryVisibility(message: Message, options?: { historyVisibility?: 'meta' | 'normal' }): Message;
  resolveExplicitAgentRouting(agentId: string): { agent: unknown; score: number; reason: string } | null;
  resolveTurnRouting(content: string, sessionId?: string, agentOverrideId?: string): Promise<{
    resolution: { agent: { id: string; name: string }; score: number; reason: string } | null;
    requestedAgentId?: string;
  }>;
  agentLoop: { steer: ReturnType<typeof vi.fn> } | null;
  isInterrupting: boolean;
  pendingSteerMessages: unknown[];
  pendingPermissions: Map<string, { resolve: (r: string) => void; parked?: boolean; request?: { sessionId?: string } }>;
  requestPermission(request: { type: string; tool: string; sessionId?: string; details?: Record<string, unknown> }): Promise<boolean>;
  resolveParkedApproval(id: string, response: string, feedbackOverride?: string): void;
  drainPendingPermissions(response?: string): void;
}
function internals(o: AgentOrchestrator): OrchestratorInternals {
  return o as unknown as OrchestratorInternals;
}
function makeMessage(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: 0 };
}
function makeAttachment(id: string, name: string): MessageAttachment {
  return {
    id,
    type: 'file',
    category: 'document',
    name,
    size: 10,
    mimeType: 'text/plain',
    data: `${name} data`,
  };
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
    queuedInputMocks.getDb.mockReturnValue(queuedInputMocks.db);

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

    it('cancel 将 interrupt 窗口内的 pending steer 分别写入 durable queue', async () => {
      const firstAttachments = [makeAttachment('attachment-one', 'one.txt')];
      const secondAttachments = [makeAttachment('attachment-two', 'two.txt')];

      internals(orchestrator).isInterrupting = true;
      await orchestrator.interruptAndContinue(
        'first pending direction',
        firstAttachments,
        undefined,
        { workbench: { workingDirectory: '/workspace/one' } },
        'pending-one-id',
      );
      await orchestrator.interruptAndContinue(
        'second pending direction',
        secondAttachments,
        undefined,
        { workbench: { selectedSkillIds: ['skill-two'] } },
        'pending-two-id',
      );

      await orchestrator.cancel();

      expect(queuedInputMocks.enqueue.mock.calls.map(([input]) => input)).toEqual([
        {
          id: 'pending-one-id',
          sessionId: 'test-session-id',
          envelope: {
            content: 'first pending direction',
            clientMessageId: 'pending-one-id',
            sessionId: 'test-session-id',
            attachments: firstAttachments,
            context: { workingDirectory: '/workspace/one' },
          },
          now: undefined,
        },
        {
          id: 'pending-two-id',
          sessionId: 'test-session-id',
          envelope: {
            content: 'second pending direction',
            clientMessageId: 'pending-two-id',
            sessionId: 'test-session-id',
            attachments: secondAttachments,
            context: { selectedSkillIds: ['skill-two'] },
          },
          now: undefined,
        },
      ]);
      expect(internals(orchestrator).pendingSteerMessages).toHaveLength(0);
    });
  });

  describe('调整方向', () => {
    it('live steer 成功时返回 steered outcome', async () => {
      const steer = vi.fn().mockResolvedValue(undefined);
      internals(orchestrator).agentLoop = { steer };

      await expect(orchestrator.interruptAndContinue('new direction')).resolves.toEqual({
        outcome: 'steered',
      });
      expect(queuedInputMocks.enqueue).not.toHaveBeenCalled();
    });

    it('live steer 在 run settled 后降级写入 durable queue 并返回 queued outcome', async () => {
      const steer = vi.fn().mockRejectedValue(new SteerRejectedError());
      internals(orchestrator).agentLoop = { steer };

      await expect(orchestrator.interruptAndContinue(
        'continue next turn',
        undefined,
        undefined,
        { workbench: { workingDirectory: '/workspace/late' } },
        'late-steer-id',
      )).resolves.toEqual({ outcome: 'queued', queuedInputId: 'late-steer-id' });
      expect(queuedInputMocks.enqueue).toHaveBeenCalledWith({
        id: 'late-steer-id',
        sessionId: 'test-session-id',
        envelope: {
          content: 'continue next turn',
          clientMessageId: 'late-steer-id',
          sessionId: 'test-session-id',
          attachments: undefined,
          context: { workingDirectory: '/workspace/late' },
        },
        now: undefined,
      });
    });

    it('传播 steer 持久化错误，并在失败后复位 interrupt 状态', async () => {
      const steer = vi.fn()
        .mockRejectedValueOnce(new Error('disk full'))
        .mockResolvedValue(undefined);
      internals(orchestrator).agentLoop = { steer };

      await expect(orchestrator.interruptAndContinue('first direction')).rejects.toThrow('disk full');
      expect(mockOnEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt_complete' }));

      await expect(orchestrator.interruptAndContinue('second direction')).resolves.toEqual({ outcome: 'steered' });
      expect(steer).toHaveBeenCalledTimes(2);
      expect(internals(orchestrator).pendingSteerMessages).toHaveLength(0);
      expect(mockOnEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'interrupt_complete' }));
    });

    it('无 agentLoop 时发送当前消息自身并分别持久化 pending steer', async () => {
      const firstAttachments = [makeAttachment('attachment-one', 'one.txt')];
      const secondAttachments = [makeAttachment('attachment-two', 'two.txt')];
      const currentAttachments = [makeAttachment('attachment-current', 'current.txt')];
      const currentOptions: AgentRunOptions = { mode: 'normal' };
      const currentMetadata = { workbench: { workingDirectory: '/workspace/current' } };

      internals(orchestrator).isInterrupting = true;
      await orchestrator.interruptAndContinue(
        'first pending direction',
        firstAttachments,
        undefined,
        { workbench: { workingDirectory: '/workspace/one' } },
        'pending-one-id',
      );
      await orchestrator.interruptAndContinue(
        'second pending direction',
        secondAttachments,
        undefined,
        { workbench: { selectedSkillIds: ['skill-two'] } },
        'pending-two-id',
      );
      internals(orchestrator).isInterrupting = false;
      const sendMessage = vi.spyOn(orchestrator, 'sendMessage').mockResolvedValue(undefined);

      await orchestrator.interruptAndContinue(
        'current direction',
        currentAttachments,
        currentOptions,
        currentMetadata,
        'current-message-id',
      );

      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        'current direction',
        currentAttachments,
        currentOptions,
        currentMetadata,
        'current-message-id',
      );
      expect(queuedInputMocks.enqueue.mock.calls.map(([input]) => input)).toEqual([
        {
          id: 'pending-one-id',
          sessionId: 'test-session-id',
          envelope: {
            content: 'first pending direction',
            clientMessageId: 'pending-one-id',
            sessionId: 'test-session-id',
            attachments: firstAttachments,
            context: { workingDirectory: '/workspace/one' },
          },
          now: undefined,
        },
        {
          id: 'pending-two-id',
          sessionId: 'test-session-id',
          envelope: {
            content: 'second pending direction',
            clientMessageId: 'pending-two-id',
            sessionId: 'test-session-id',
            attachments: secondAttachments,
            context: { selectedSkillIds: ['skill-two'] },
          },
          now: undefined,
        },
      ]);
      expect(internals(orchestrator).pendingSteerMessages).toHaveLength(0);
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

  // --------------------------------------------------------------------------
  // B2: 无人值守审批停车挂起
  // --------------------------------------------------------------------------
  describe('B2 无人值守审批停车挂起', () => {
    // WHERE status='pending' 守卫 + changes 语义的内存版 fake，忠实映射真 repo 裁决口。
    // 真 SQL 语义另在 PendingApprovalRepository.test.ts 覆盖。
    function makeFakeRepo() {
      const rows = new Map<string, { status: string; kind: string; feedback: string | null }>();
      const insert = vi.fn((input: { id: string; kind: string }) => {
        rows.set(input.id, { status: 'pending', kind: input.kind, feedback: null });
      });
      const resolve = vi.fn((input: { id: string; status: string; feedback: string | null }) => {
        const row = rows.get(input.id);
        if (!row || row.status !== 'pending') return 0;
        row.status = input.status;
        row.feedback = input.feedback;
        return 1;
      });
      const markPendingAsOrphaned = vi.fn((kind: string) => {
        const orphaned: Array<{ id: string; kind: string }> = [];
        for (const [id, row] of rows) {
          if (row.kind === kind && row.status === 'pending') {
            row.status = 'orphaned';
            orphaned.push({ id, kind });
          }
        }
        return orphaned;
      });
      const repo = { insert, resolve, markPendingAsOrphaned } as unknown as PendingApprovalRepository;
      return { repo, insert, resolve, markPendingAsOrphaned, rows };
    }

    let fake: ReturnType<typeof makeFakeRepo>;
    let parkedOrch: AgentOrchestrator;
    let unattendedSid: string;

    beforeEach(() => {
      fake = makeFakeRepo();
      parkedOrch = new AgentOrchestrator({
        configService: mockConfigService,
        onEvent: mockOnEvent,
        pendingApprovalRepo: fake.repo,
      });
      unattendedSid = `unattended-${Math.random().toString(36).slice(2)}`;
      getPermissionModeManager().markUnattendedSession(unattendedSid);
    });

    const parkRequest = (sessionId: string) =>
      internals(parkedOrch).requestPermission({
        type: 'command',
        tool: 'bash',
        sessionId,
        details: { command: 'echo external' },
      });

    // 短暂等待，确认 promise 未被 resolve（仍在停车）。
    const isStillPending = async (p: Promise<boolean>) => {
      const sentinel = Symbol('pending');
      const race = await Promise.race([p, Promise.resolve(sentinel)]);
      return race === sentinel;
    };

    it('无人值守：审批停车挂起而非 60s deny（写 pending_approvals + 内存登记 parked）', async () => {
      const promise = parkRequest(unattendedSid);
      expect(await isStillPending(promise)).toBe(true);
      expect(fake.insert).toHaveBeenCalledTimes(1);
      expect(fake.insert.mock.calls[0][0]).toMatchObject({ kind: 'tool_approval' });
      const requestId = fake.insert.mock.calls[0][0].id as string;
      const entry = internals(parkedOrch).pendingPermissions.get(requestId);
      expect(entry?.parked).toBe(true);
      // 收尾避免悬挂 promise
      internals(parkedOrch).resolveParkedApproval(requestId, 'deny');
      expect(await promise).toBe(false);
    });

    it('有人值守：60s 交互路径不变，不写 pending_approvals', async () => {
      const attendedSid = `attended-${Math.random().toString(36).slice(2)}`;
      const promise = internals(parkedOrch).requestPermission({
        type: 'command',
        tool: 'bash',
        sessionId: attendedSid,
        details: { command: 'echo hi' },
      });
      expect(await isStillPending(promise)).toBe(true);
      expect(fake.insert).not.toHaveBeenCalled();
      const requestId = [...internals(parkedOrch).pendingPermissions.keys()][0];
      const entry = internals(parkedOrch).pendingPermissions.get(requestId);
      expect(entry?.parked).toBeFalsy();
      parkedOrch.handlePermissionResponse(requestId, 'allow');
      expect(await promise).toBe(true);
    });

    it('双口竞态：以 repo changes 为唯一裁决，第二口静默 no-op（不二次 resolve）', async () => {
      const promise = parkRequest(unattendedSid);
      await isStillPending(promise);
      const requestId = fake.insert.mock.calls[0][0].id as string;

      // 第一口：批准 → repo changes=1，赢裁决
      parkedOrch.handlePermissionResponse(requestId, 'allow');
      expect(await promise).toBe(true);
      expect(fake.rows.get(requestId)?.status).toBe('approved');

      // 第二口（抢答后到达）：即便手动残留一个内存项，repo changes=0 也不得二次 resolve
      const secondResolve = vi.fn();
      internals(parkedOrch).pendingPermissions.set(requestId, {
        resolve: secondResolve,
        parked: true,
        request: { sessionId: unattendedSid },
      });
      internals(parkedOrch).resolveParkedApproval(requestId, 'deny');
      expect(secondResolve).not.toHaveBeenCalled();
      expect(fake.rows.get(requestId)?.status).toBe('approved'); // 仍是第一口结果
    });

    it('取消收尾：drainPendingPermissions 同步 repo resolve(rejected) 不留孤儿', async () => {
      const promise = parkRequest(unattendedSid);
      await isStillPending(promise);
      const requestId = fake.insert.mock.calls[0][0].id as string;
      expect(fake.rows.get(requestId)?.status).toBe('pending');

      internals(parkedOrch).drainPendingPermissions('deny');
      expect(await promise).toBe(false);
      const row = fake.rows.get(requestId);
      expect(row?.status).toBe('rejected'); // 不再是 pending 孤儿
      expect(row?.feedback).toBe('run cancelled');
      expect(internals(parkedOrch).pendingPermissions.has(requestId)).toBe(false);
    });

    it('24h 兜底：无人应答超时 deny + repo rejected', async () => {
      vi.useFakeTimers();
      try {
        const promise = parkRequest(unattendedSid);
        const requestId = fake.insert.mock.calls[0][0].id as string;
        vi.advanceTimersByTime(86_400_000);
        expect(await promise).toBe(false);
        expect(fake.rows.get(requestId)?.status).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('停车不阻塞他人：A 会话停车挂起时 B 会话审批照常完成', async () => {
      const promiseA = parkRequest(unattendedSid);
      await isStillPending(promiseA);

      const attendedSid = `attended-${Math.random().toString(36).slice(2)}`;
      const promiseB = internals(parkedOrch).requestPermission({
        type: 'command',
        tool: 'bash',
        sessionId: attendedSid,
        details: { command: 'echo B' },
      });
      const bId = [...internals(parkedOrch).pendingPermissions.keys()].find(
        (k) => !internals(parkedOrch).pendingPermissions.get(k)?.parked,
      )!;
      parkedOrch.handlePermissionResponse(bId, 'allow');
      expect(await promiseB).toBe(true);           // B 全程正常
      expect(await isStillPending(promiseA)).toBe(true); // A 仍停车，未受影响

      const aId = fake.insert.mock.calls[0][0].id as string;
      internals(parkedOrch).resolveParkedApproval(aId, 'deny');
      expect(await promiseA).toBe(false);
    });

    it('停车发内部 parked 事件（B3 挂点）', async () => {
      const parkedSpy = vi.fn();
      approvalParkEvents.on('parked', parkedSpy);
      try {
        const promise = parkRequest(unattendedSid);
        await isStillPending(promise);
        expect(parkedSpy).toHaveBeenCalledTimes(1);
        expect(parkedSpy.mock.calls[0][0]).toMatchObject({ tool: 'bash', sessionId: unattendedSid });
        const requestId = fake.insert.mock.calls[0][0].id as string;
        internals(parkedOrch).resolveParkedApproval(requestId, 'deny');
        await promise;
      } finally {
        approvalParkEvents.off('parked', parkedSpy);
      }
    });
  });
});
