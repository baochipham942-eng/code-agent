// ============================================================================
// CLI Bootstrap - 服务初始化 (无 Electron 依赖)
// ============================================================================

// 首先注入 Electron mock（必须在任何其他导入之前）
import electronMock from './electron-mock';

// 注入到 require cache
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
  if (id === 'electron') {
    return electronMock;
  }
  return originalRequire.apply(this, arguments);
};

// 现在可以安全导入其他模块了
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getCLIConfigService, type CLIConfigService } from './config';
import { initCLIDatabase, getCLIDatabase, type CLIDatabaseService } from './database';
import { getCLISessionManager, type CLISessionManager } from './session';
import type { CLIConfig, CLIEventHandler } from './types';
import type { Generation, ModelConfig, Message, AgentEvent } from '../shared/types';
import { DEFAULT_MODELS, DEFAULT_GENERATION, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../shared/constants';

// 延迟导入的模块
let AgentLoop: typeof import('../main/agent/agentLoop').AgentLoop;
let ToolRegistry: typeof import('../main/tools/toolRegistry').ToolRegistry;
let ToolExecutor: typeof import('../main/tools/toolExecutor').ToolExecutor;
let GenerationManager: typeof import('../main/generation/generationManager').GenerationManager;
let getSkillDiscoveryService: typeof import('../main/services/skills').getSkillDiscoveryService;
let getTelemetryCollector: typeof import('../main/telemetry').getTelemetryCollector;

// CLI 数据目录
function getCLIDataDir(): string {
  const homeDir = os.homedir();
  const dataDir = path.join(homeDir, '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

// 全局状态
let configService: CLIConfigService | null = null;
let databaseService: CLIDatabaseService | null = null;
let sessionManager: CLISessionManager | null = null;
let generationManager: InstanceType<typeof GenerationManager> | null = null;
let toolRegistry: InstanceType<typeof ToolRegistry> | null = null;
let toolExecutor: InstanceType<typeof ToolExecutor> | null = null;
let initialized = false;
let currentTelemetrySessionId: string | null = null;

/**
 * 初始化 CLI 核心服务
 */
export async function initializeCLIServices(): Promise<void> {
  if (initialized) return;

  console.log('Initializing CLI services...');

  // 设置环境变量
  const dataDir = getCLIDataDir();
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_CLI_MODE = 'true';

  // 初始化配置服务
  configService = getCLIConfigService();
  await configService.initialize();
  console.log('ConfigService initialized');

  // 初始化数据库
  try {
    databaseService = await initCLIDatabase();
    console.log('Database initialized');
  } catch (error) {
    // 数据库失败不阻止 CLI 运行，只是缓存和会话持久化不可用
    // 原生模块 ABI 不匹配时只打一行警告，不打完整堆栈
    const msg = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.warn('Database not available (CLI mode):', msg);
  }

  // 初始化会话管理器
  sessionManager = getCLISessionManager();
  console.log('SessionManager initialized');

  // 动态导入核心模块
  try {
    const agentLoopModule = await import('../main/agent/agentLoop');
    AgentLoop = agentLoopModule.AgentLoop;

    const toolRegistryModule = await import('../main/tools/toolRegistry');
    ToolRegistry = toolRegistryModule.ToolRegistry;

    const toolExecutorModule = await import('../main/tools/toolExecutor');
    ToolExecutor = toolExecutorModule.ToolExecutor;

    const generationManagerModule = await import('../main/generation/generationManager');
    GenerationManager = generationManagerModule.GenerationManager;

    const skillsModule = await import('../main/services/skills');
    getSkillDiscoveryService = skillsModule.getSkillDiscoveryService;

    const telemetryModule = await import('../main/telemetry');
    getTelemetryCollector = telemetryModule.getTelemetryCollector;
  } catch (error) {
    console.error('Failed to import core modules:', error);
    throw error;
  }

  // 初始化代际管理器
  generationManager = new GenerationManager();
  console.log('GenerationManager initialized');

  // 初始化工具注册表
  toolRegistry = new ToolRegistry();

  // 初始化工具执行器（CLI 模式下自动批准所有工具）
  toolExecutor = new ToolExecutor({
    toolRegistry,
    requestPermission: async () => true, // CLI 模式自动批准
    workingDirectory: process.cwd(),
  });
  console.log('ToolRegistry & ToolExecutor initialized');

  // 初始化记忆服务
  try {
    const { initMemoryService } = await import('../main/memory/memoryService');
    const { getVectorStore } = await import('../main/memory/vectorStore');

    const memoryService = initMemoryService({
      maxRecentMessages: 10,
      toolCacheTTL: 5 * 60 * 1000,
      maxSessionMessages: 100,
      maxRAGResults: 5,
      ragTokenLimit: 2000,
    });

    // 加载持久化的向量数据
    const vectorStore = getVectorStore();
    await vectorStore.initialize();

    // 设置上下文（使用工作目录作为 projectPath）
    memoryService.setContext(`cli-${Date.now()}`, process.cwd());

    console.log('Memory service initialized');
  } catch (error) {
    console.error('Failed to initialize memory service:', error);
    // 不阻止 CLI 运行，记忆功能降级
  }

  // 初始化 Skill 发现服务
  try {
    const skillDiscoveryService = getSkillDiscoveryService();
    await skillDiscoveryService.initialize(process.cwd());
    console.log('SkillDiscoveryService initialized');
  } catch (error) {
    console.error('Failed to initialize SkillDiscoveryService:', error);
    // 不抛出错误，允许 CLI 继续运行（skills 功能降级）
  }

  initialized = true;
  console.log('CLI services initialized');
}

/**
 * 获取配置服务
 */
export function getConfigService(): CLIConfigService {
  if (!configService) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return configService;
}

/**
 * 获取数据库服务
 */
export function getDatabaseService(): CLIDatabaseService | null {
  return databaseService;
}

/**
 * 获取会话管理器
 */
export function getSessionManager(): CLISessionManager {
  if (!sessionManager) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return sessionManager;
}

/**
 * 获取代际管理器
 */
export function getGenerationManager(): InstanceType<typeof GenerationManager> {
  if (!generationManager) {
    throw new Error('CLI services not initialized. Call initializeCLIServices() first.');
  }
  return generationManager;
}

/**
 * 构建 CLI 配置
 */
export function buildCLIConfig(options: {
  project?: string;
  gen?: string;
  model?: string;
  provider?: string;
  json?: boolean;
  plan?: boolean;
  debug?: boolean;
}): CLIConfig {
  const config = getConfigService();
  const settings = config.getSettings();

  // 工作目录
  const workingDirectory = options.project
    ? path.resolve(options.project)
    : process.cwd();

  // 代际
  const generationId = options.gen || settings.generation?.default || DEFAULT_GENERATION;

  // 模型配置
  const provider = options.provider || settings.model?.provider || DEFAULT_PROVIDER;
  const model = options.model || settings.model?.model || DEFAULT_MODELS.chat;

  const modelConfig: ModelConfig = {
    provider: provider as ModelConfig['provider'],
    model,
    apiKey: config.getApiKey(provider) || '',
    temperature: settings.model?.temperature || 0.7,
    maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
  };

  return {
    workingDirectory,
    generationId,
    modelConfig,
    outputFormat: options.json ? 'json' : 'text',
    enablePlanning: options.plan || false,
    debug: options.debug || false,
    autoApprovePlan: true, // CLI 模式默认自动批准 plan mode
  };
}

/**
 * 创建 AgentLoop 实例
 */
export function createAgentLoop(
  config: CLIConfig,
  onEvent: CLIEventHandler,
  messages: Message[] = [],
  sessionId?: string
): InstanceType<typeof AgentLoop> {
  if (!toolRegistry || !toolExecutor || !generationManager || !AgentLoop) {
    throw new Error('CLI services not initialized');
  }

  // 获取代际配置
  const generation = generationManager.getGeneration(config.generationId as import('../shared/types').GenerationId);
  if (!generation) {
    throw new Error(`Generation ${config.generationId} not found`);
  }

  // 统一使用传入的 sessionId，或生成一个临时 ID
  const effectiveSessionId = sessionId || `cli-${Date.now()}`;

  // 创建 PlanningService（如果启用规划模式）
  let planningService = undefined;
  if (config.enablePlanning) {
    const { createPlanningService } = require('../main/planning/planningService');
    planningService = createPlanningService(config.workingDirectory, effectiveSessionId);
    planningService.initialize().catch((err: Error) => {
      console.error('Failed to initialize planning service:', err);
    });
    if (config.debug) {
      console.log('[Planning] Planning mode enabled');
    }
  }

  // Telemetry: 开始会话追踪
  let telemetryAdapter = undefined;
  if (getTelemetryCollector) {
    try {
      const collector = getTelemetryCollector();
      collector.startSession(effectiveSessionId, {
        title: 'CLI Session',
        generationId: config.generationId,
        modelProvider: config.modelConfig.provider,
        modelName: config.modelConfig.model,
        workingDirectory: config.workingDirectory,
      });
      telemetryAdapter = collector.createAdapter(effectiveSessionId, 'cli');
      currentTelemetrySessionId = effectiveSessionId;
    } catch (error) {
      // Telemetry 失败不阻止运行
      console.warn('[Telemetry] Failed to start session:', (error as Error).message);
    }
  }

  // 创建 AgentLoop
  const agentLoop = new AgentLoop({
    generation,
    modelConfig: config.modelConfig,
    toolRegistry,
    toolExecutor,
    messages,
    onEvent: (event: AgentEvent) => {
      if (config.debug) {
        console.log('[AgentEvent]', event.type);
      }
      onEvent(event);
    },
    enableHooks: config.enablePlanning, // 规划模式启用 hooks
    planningService,
    sessionId: effectiveSessionId,
    workingDirectory: config.workingDirectory,
    isDefaultWorkingDirectory: false,
    autoApprovePlan: config.autoApprovePlan, // CLI 模式自动批准 plan mode
    enableToolDeferredLoading: true, // 延迟加载非核心工具，减少 tool overhead
    telemetryAdapter,
    // CLI 消息持久化回调（包含 tool_results）
    persistMessage: async (message: Message) => {
      if (sessionManager) {
        try {
          await sessionManager.addMessage(message);
        } catch (error) {
          console.warn('[CLI] Failed to persist message:', (error as Error).message);
        }
      }
    },
  });

  return agentLoop;
}

/**
 * 清理资源
 */
export async function cleanup(): Promise<void> {
  console.log('Cleaning up CLI services...');

  // Telemetry: 结束会话并同步 token 使用到 sessions 表
  if (currentTelemetrySessionId && getTelemetryCollector) {
    try {
      const collector = getTelemetryCollector();
      const sessionData = collector.getSessionData(currentTelemetrySessionId);
      collector.endSession(currentTelemetrySessionId);

      // 同步 token usage 到 CLI sessions 表
      if (sessionData && sessionManager) {
        await sessionManager.updateSession(currentTelemetrySessionId, {
          lastTokenUsage: {
            inputTokens: sessionData.totalInputTokens,
            outputTokens: sessionData.totalOutputTokens,
            totalTokens: sessionData.totalTokens,
          },
        } as any);
      }
    } catch (error) {
      console.warn('[Telemetry] Failed to end session:', (error as Error).message);
    }
    currentTelemetrySessionId = null;
  }

  // 关闭数据库连接
  if (databaseService) {
    databaseService.close();
    databaseService = null;
  }

  initialized = false;
  console.log('CLI services cleaned up');
}
