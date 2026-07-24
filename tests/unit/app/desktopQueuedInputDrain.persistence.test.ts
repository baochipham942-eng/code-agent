import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');

import type { ModelResponse } from '../../../src/host/model/types';
import type { ConfigService } from '../../../src/host/services/core/configService';

const previousEnv = vi.hoisted(() => {
  const snapshot = {
    codeAgentE2E: process.env.CODE_AGENT_E2E,
    codeAgentCliMode: process.env.CODE_AGENT_CLI_MODE,
    codeAgentWebMode: process.env.CODE_AGENT_WEB_MODE,
    codeAgentModelEngine: process.env.CODE_AGENT_MODEL_ENGINE,
  };
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_WEB_MODE = '1';
  process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  delete process.env.CODE_AGENT_CLI_MODE;
  return snapshot;
});

const testState = vi.hoisted(() => ({
  userDataPath: '/tmp/desktop-drain-persistence-uninitialized',
}));

const loggerMocks = vi.hoisted(() => {
  const createLogger = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    setLevel: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  });
  return {
    logger: createLogger(),
    createLogger: vi.fn(() => createLogger()),
    LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
  };
});

const configServiceMocks = vi.hoisted(() => {
  const settings = {
    models: {
      defaultProvider: 'openai',
      providers: {
        openai: { enabled: true, model: 'gpt-4o-mini' },
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
    connectors: { enabledNative: [] },
  };
  const service = {
    getSettings: vi.fn(() => settings),
    getApiKey: vi.fn(() => 'test-key'),
    getServiceApiKey: vi.fn(() => ''),
    getIntegration: vi.fn(() => undefined),
    getModelForCapability: vi.fn(() => undefined),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service,
    isProduction: vi.fn(() => false),
    sanitizeForLogging: vi.fn((value: unknown) => value),
    safeLog: vi.fn(),
    ConfigService: vi.fn(() => service),
    initConfigService: vi.fn(() => service),
    getConfigService: vi.fn(() => service),
  };
});

const browserMocks = vi.hoisted(() => {
  const service = {
    initialize: vi.fn(),
    close: vi.fn(),
    listTabs: vi.fn(() => []),
    getSessionState: vi.fn(() => ({
      isRunning: false,
      profileId: 'desktop-drain-test-profile',
      profileDir: '/tmp/desktop-drain-test-profile',
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

const modelRouterMocks = vi.hoisted(() => ({
  inference: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  app: {
    getPath: (name: string) => name === 'userData' ? testState.userDataPath : testState.userDataPath,
  },
  AppWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../../../src/host/services/infra/logger', () => loggerMocks);
vi.mock('../../../src/host/services/infra/logger.js', () => loggerMocks);
vi.mock('../../../src/host/services/core/configService', () => configServiceMocks);
vi.mock('../../../src/host/services/core/configService.js', () => configServiceMocks);

vi.mock('../../../src/host/services/infra/browserService.js', () => ({
  browserService: browserMocks.service,
  BrowserService: vi.fn(() => browserMocks.service),
  redactBrowserWorkbenchTraceParams: (_toolName: string, params: Record<string, unknown>) => params,
}));

vi.mock('../../../src/host/services/infra/browserPool.js', () => ({
  browserPool: {
    acquire: vi.fn(() => browserMocks.service),
  },
  getBrowserService: vi.fn(() => browserMocks.service),
}));

vi.mock('../../../src/host/services/cloud/cloudConfigService', () => ({
  getCloudConfigService: vi.fn(() => ({
    getAllToolMeta: vi.fn(() => ({})),
    getToolMeta: vi.fn(() => undefined),
    getFeatureFlag: vi.fn(() => undefined),
    isFeatureDisabledByPolicy: vi.fn(() => false),
    getSkills: vi.fn(() => []),
    getSkillCatalog: vi.fn(() => []),
  })),
}));

// featureFlagService 持有模块级单例，可能在 cloudConfigService mock 生效前用真实
// 实例初始化（同 conversationRuntime.test 的处理）——整模块打桩绕开单例路径。
vi.mock('../../../src/host/services/cloud/featureFlagService', () => {
  const flagServiceStub = {
    getAll: vi.fn(() => ({})),
    isCloudAgentEnabled: vi.fn(() => false),
    isMemoryEnabled: vi.fn(() => false),
    isComputerUseEnabled: vi.fn(() => false),
    getMaxIterations: vi.fn(() => 25),
    getMaxMessageLength: vi.fn(() => 100_000),
    isExperimentalToolsEnabled: vi.fn(() => false),
    isEnabled: vi.fn(() => false),
  };
  return {
    FeatureFlagService: class {},
    getFeatureFlagService: vi.fn(() => flagServiceStub),
    isMemoryEnabled: vi.fn(() => false),
    isComputerUseEnabled: vi.fn(() => false),
    getMaxIterations: vi.fn(() => 25),
    getMaxMessageLength: vi.fn(() => 100_000),
    isExperimentalToolsEnabled: vi.fn(() => false),
  };
});

vi.mock('../../../src/host/model/modelRouter', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/model/modelRouter')>();
  type OriginalModelRouter = InstanceType<typeof original.ModelRouter>;
  return {
    ...original,
    ModelRouter: class extends original.ModelRouter {
      override inference(
        ...args: Parameters<OriginalModelRouter['inference']>
      ): ReturnType<OriginalModelRouter['inference']> {
        return modelRouterMocks.inference(...args) as ReturnType<OriginalModelRouter['inference']>;
      }
    },
  };
});

vi.mock('../../../src/host/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/hooks')>();
  const allow = () => Promise.resolve({
    shouldProceed: true,
    results: [],
    totalDuration: 0,
  });
  return {
    ...original,
    createHookManager: () => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      triggerSessionStart: vi.fn(allow),
      triggerSessionEnd: vi.fn(allow),
      triggerUserPromptSubmit: vi.fn(allow),
      triggerStop: vi.fn(allow),
      triggerPostExecution: vi.fn(allow),
      triggerPreToolUse: vi.fn(allow),
      triggerPostToolUse: vi.fn(allow),
      triggerPostToolUseFailure: vi.fn(allow),
      triggerPreCompact: vi.fn(allow),
      triggerPostCompact: vi.fn(allow),
    }),
  };
});

vi.mock('../../../src/host/agent/agentRequirementsAnalyzer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/agent/agentRequirementsAnalyzer')>();
  return {
    ...original,
    getAgentRequirementsAnalyzer: () => ({
      analyze: vi.fn(async () => ({
        taskType: 'code',
        suggestedAgents: [],
        toolConstraints: {},
        executionStrategy: 'direct',
        estimatedIterations: 1,
        confidence: 1,
        needsAutoAgent: false,
        rawAnalysis: {},
      })),
    }),
  };
});

vi.mock('../../../src/host/routing/intentClassifier', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/routing/intentClassifier')>();
  return {
    ...original,
    classifyIntent: vi.fn(async () => ({
      intent: 'code',
      references_past_context: false,
    })),
  };
});

import { AgentAppServiceImpl } from '../../../src/host/app/agentAppService';
import { registerDesktopQueuedInputDrain } from '../../../src/host/app/desktopQueuedInputDrain';
import type { ModelRouter } from '../../../src/host/model/modelRouter';
import { initDatabase } from '../../../src/host/services/core/databaseService';
import { QueuedInputRepository } from '../../../src/host/services/core/repositories/QueuedInputRepository';
import { getSessionManager } from '../../../src/host/services/infra/sessionManager';
import { TaskManager } from '../../../src/host/task/TaskManager';

describe('desktop queued input drain persistence', () => {
  const sessionId = 'desktop-drain-persistence-session';
  const queuedInputId = 'desktop-drain-persistence-user';
  const drainedUserContent = 'persist this drained desktop turn';
  const drainedAssistantContent = 'desktop drained reply persisted';
  let tmpDir: string;
  let unregisterDrain: (() => void) | undefined;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-drain-persistence-'));
    testState.userDataPath = tmpDir;
  });

  afterAll(async () => {
    unregisterDrain?.();
    const database = await initDatabase();
    database.close();
    await getSessionManager().dispose();
    if (previousEnv.codeAgentE2E === undefined) delete process.env.CODE_AGENT_E2E;
    else process.env.CODE_AGENT_E2E = previousEnv.codeAgentE2E;
    if (previousEnv.codeAgentCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
    else process.env.CODE_AGENT_CLI_MODE = previousEnv.codeAgentCliMode;
    if (previousEnv.codeAgentWebMode === undefined) delete process.env.CODE_AGENT_WEB_MODE;
    else process.env.CODE_AGENT_WEB_MODE = previousEnv.codeAgentWebMode;
    if (previousEnv.codeAgentModelEngine === undefined) delete process.env.CODE_AGENT_MODEL_ENGINE;
    else process.env.CODE_AGENT_MODEL_ENGINE = previousEnv.codeAgentModelEngine;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists both messages when cancellation settles and host drain runs the queued turn', async () => {
    const database = await initDatabase();
    database.createSessionWithId(sessionId, {
      title: 'Desktop drain persistence evidence',
      modelConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      engine: { kind: 'native' },
    });

    const repository = new QueuedInputRepository(database.getDb()!);
    repository.enqueue({
      id: queuedInputId,
      sessionId,
      envelope: { content: drainedUserContent },
      now: 1,
    });

    let cancelledInferenceStarted: (() => void) | undefined;
    const cancelledInferenceReady = new Promise<void>((resolve) => {
      cancelledInferenceStarted = resolve;
    });
    const inference: ModelRouter['inference'] = async (
      messages,
      _tools,
      _config,
      _onStream,
      signal,
    ): Promise<ModelResponse> => {
        const latestUserContent = [...messages]
          .reverse()
          .find((message) => message.role === 'user')?.content;
        const text = typeof latestUserContent === 'string'
          ? latestUserContent
          : latestUserContent?.map((part) => part.text ?? '').join('') ?? '';

        if (text.includes('cancel this desktop run')) {
          cancelledInferenceStarted?.();
          return new Promise<ModelResponse>((_resolve, reject) => {
            const rejectCancelled = () => reject(new Error('desktop test inference cancelled'));
            if (signal?.aborted) rejectCancelled();
            else signal?.addEventListener('abort', rejectCancelled, { once: true });
          });
        }

        return {
          type: 'text',
          content: drainedAssistantContent,
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
        };
    };
    modelRouterMocks.inference.mockImplementation(inference);

    const manager = new TaskManager({ maxConcurrentTasks: 1 });
    manager.initialize({
      configService: configServiceMocks.service as unknown as ConfigService,
      onAgentEvent: vi.fn(),
    });
    const appService = new AgentAppServiceImpl(
      () => manager,
      () => configServiceMocks.service as unknown as ConfigService,
      () => sessionId,
      vi.fn(),
    );
    unregisterDrain = registerDesktopQueuedInputDrain({
      taskManager: manager,
      appService,
      repository,
    }).dispose;

    // drain 轮是一整个真实 orchestrator 回合（仅 inference 打桩），负载下合法耗时
    // 可超过 vi.waitFor 默认 1s 窗口——等 task_completed 这个确定性完成信号
    // （被取消轮发的是 task_cancelled，不会误触），而不是用固定窗口轮询 DB 状态。
    const drainedTurnCompleted = new Promise<void>((resolve) => {
      const onCompleted = (event: { sessionId: string }): void => {
        if (event.sessionId !== sessionId) return;
        manager.off('task_completed', onCompleted);
        resolve();
      };
      manager.on('task_completed', onCompleted);
    });

    const cancelledRun = manager.startTask(sessionId, 'cancel this desktop run');
    await Promise.race([
      cancelledInferenceReady,
      new Promise<never>((_resolve, reject) => {
        // Loading the real orchestrator now also resolves an immutable Project Source
        // snapshot before inference; cold CI/worktree module loading can exceed 5s.
        setTimeout(() => reject(new Error('cancelled run did not reach ModelRouter inference')), 20_000);
      }),
    ]);
    await manager.cancelTask(sessionId);
    await cancelledRun;

    await drainedTurnCompleted;
    // task_completed 之后 markConsumed 只隔几个微任务，默认窗口只兜收尾。
    await vi.waitFor(() => {
      expect(repository.getById(queuedInputId)?.status).toBe('consumed');
    });

    const session = await getSessionManager().getSession(sessionId, 20);
    const drainedUser = session?.messages.find((message) => message.id === queuedInputId);
    const drainedAssistant = session?.messages.find(
      (message) => message.role === 'assistant' && message.content === drainedAssistantContent,
    );

    expect(drainedUser).toMatchObject({
      id: queuedInputId,
      role: 'user',
      content: drainedUserContent,
    });
    expect(drainedAssistant).toMatchObject({
      role: 'assistant',
      content: drainedAssistantContent,
    });
  }, 30_000);
});
