// ============================================================================
// Bootstrap V2 - 基于 DI 容器的服务初始化
// ============================================================================
//
// 使用依赖注入容器和生命周期管理器重构服务初始化逻辑
// 向后兼容：保持旧版本的导出接口
//
// 迁移策略：
// 1. 先创建新版本的初始化逻辑
// 2. 在 main.ts 中切换到新版本
// 3. 验证功能正常后删除旧版本
//

import { app } from 'electron';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import {
  Container,
  LifecycleManager,
  ServicePhase,
  getContainer,
  setContainer,
  getLifecycle,
  setLifecycle,
  ConfigServiceToken,
  GenerationManagerToken,
  SessionManagerToken,
} from '../core';
import {
  ConfigService,
  initSupabase,
  isSupabaseInitialized,
  getAuthService,
  getSyncService,
  initLangfuse,
  getSessionManager,
  notificationService,
} from '../services';
import { initUpdateService, getUpdateService } from '../services/cloud/updateService';
import { getMemoryService } from '../memory/memoryService';
import { initMCPClient, getMCPClient, type MCPServerConfig } from '../mcp/mcpClient';
import { initPromptService, getPromptsInfo } from '../services/cloud/promptService';
import { initCloudConfigService, getCloudConfigService } from '../services/cloud';
import { initCloudTaskService } from '../cloud/cloudTaskService';
import { initUnifiedOrchestrator } from '../orchestrator';
import { logBridge } from '../mcp/logBridge.js';
import { initPluginSystem, shutdownPluginSystem } from '../plugins';
import { getSkillDiscoveryService, getSkillRepositoryService } from '../services/skills';
import { getMainWindow } from './window';
import { IPC_CHANNELS } from '../../shared/ipc';
import { SYNC, UPDATE, CLOUD, TOOL_CACHE, getCloudApiUrl, DEFAULT_MODELS } from '../../shared/constants';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { GenerationManager } from '../generation/generationManager';
import { createPlanningService, type PlanningService } from '../planning';
import { getTaskManager, type TaskManager } from '../task';
import type { PlanningState, ToolCall } from '../../shared/types';

const logger = createLogger('BootstrapV2');

// ----------------------------------------------------------------------------
// Global State (保持向后兼容)
// ----------------------------------------------------------------------------

let agentOrchestrator: AgentOrchestrator | null = null;
let currentSessionId: string | null = null;
let planningService: PlanningService | null = null;

// ----------------------------------------------------------------------------
// 向后兼容的导出函数
// 这些函数保持与旧版 bootstrap.ts 相同的接口
// ----------------------------------------------------------------------------

/**
 * 获取配置服务实例
 */
export function getConfigServiceInstance(): ConfigService | null {
  try {
    const container = getContainer();
    if (container.isInitialized(ConfigServiceToken)) {
      return container.resolveSync(ConfigServiceToken);
    }
  } catch {
    // 容器未初始化或服务未注册
  }
  return null;
}

/**
 * 获取 Agent Orchestrator 实例
 */
export function getAgentOrchestrator(): AgentOrchestrator | null {
  return agentOrchestrator;
}

/**
 * 获取 Generation Manager 实例
 */
export function getGenerationManagerInstance(): GenerationManager | null {
  try {
    const container = getContainer();
    if (container.isInitialized(GenerationManagerToken)) {
      return container.resolveSync(GenerationManagerToken);
    }
  } catch {
    // 容器未初始化或服务未注册
  }
  return null;
}

/**
 * 获取当前会话 ID
 */
export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

/**
 * 设置当前会话 ID
 */
export function setCurrentSessionId(id: string): void {
  currentSessionId = id;
}

/**
 * 获取 Planning Service 实例
 */
export function getPlanningServiceInstance(): PlanningService | null {
  return planningService;
}

/**
 * 获取 TaskManager 实例
 */
export function getTaskManagerInstance(): TaskManager | null {
  return getTaskManager();
}

// ----------------------------------------------------------------------------
// 服务定义（本地定义，避免循环依赖）
// ----------------------------------------------------------------------------

function defineServices(lifecycle: LifecycleManager): void {
  const { createToken } = require('../core/container');

  // ConfigService
  lifecycle.define({
    token: ConfigServiceToken,
    phase: ServicePhase.Core,
    factory: async () => {
      const { ConfigService } = await import('../services/core/configService');
      const service = new ConfigService();
      await service.initialize();
      return service;
    },
    critical: true,
  });

  // DatabaseService (使用现有的单例模式)
  const DatabaseToken = createToken('DatabaseService');
  lifecycle.define({
    token: DatabaseToken,
    phase: ServicePhase.Core,
    factory: async () => {
      const { initDatabase, getDatabase } = await import('../services/core/databaseService');
      await initDatabase();
      const userDataPath = app.getPath('userData');
      logger.info('Database initialized', { path: path.join(userDataPath, 'code-agent.db') });
      return getDatabase();
    },
    critical: true,
  });

  // MemoryService
  const MemoryToken = createToken('MemoryService');
  lifecycle.define({
    token: MemoryToken,
    phase: ServicePhase.Core,
    factory: async () => {
      const { initMemoryService, getMemoryService } = await import('../memory/memoryService');
      initMemoryService({
        maxRecentMessages: 10,
        toolCacheTTL: TOOL_CACHE.DEFAULT_TTL,
        maxSessionMessages: 100,
        maxRAGResults: 5,
        ragTokenLimit: 2000,
      });
      logger.info('Memory service initialized');
      return getMemoryService();
    },
    dependencies: [DatabaseToken],
    critical: true,
  });

  // GenerationManager
  lifecycle.define({
    token: GenerationManagerToken,
    phase: ServicePhase.Background,
    factory: async () => {
      const { GenerationManager } = await import('../generation/generationManager');
      return new GenerationManager();
    },
    critical: true,
  });
}

// ----------------------------------------------------------------------------
// 核心初始化逻辑
// ----------------------------------------------------------------------------

/**
 * 核心服务初始化 - 必须在窗口创建前完成
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  logger.info('Initializing core services with DI container...');

  // 创建容器和生命周期管理器
  const container = new Container({
    autoInitialize: true,
    initializeTimeout: 30000,
  });
  setContainer(container);

  const lifecycle = new LifecycleManager(container, {
    defaultTimeout: 30000,
    parallelInit: true,
  });
  setLifecycle(lifecycle);

  // 定义服务
  defineServices(lifecycle);

  // 启动核心服务
  await lifecycle.startCore();

  // 获取配置服务
  const configService = container.resolveSync(ConfigServiceToken);

  // 初始化 Supabase（需要在核心阶段完成，因为 auth IPC handlers 依赖它）
  const DEFAULT_SUPABASE_URL = 'https://xepbunahzbmexsmmiqyq.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGJ1bmFoemJtZXhzbW1pcXlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODkyMTcsImV4cCI6MjA4NDA2NTIxN30.8swN1QdRX5vIjNyCLNhQTPAx-k2qxeS8EN4Ot2idY7w';

  const settings = configService.getSettings();
  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;

  initSupabase(supabaseUrl, supabaseAnonKey);
  logger.info('Supabase initialized (core)');

  logger.info('Core services initialized with DI container');
  return configService;
}

/**
 * 后台服务初始化 - 窗口创建后异步执行
 */
export async function initializeBackgroundServices(): Promise<void> {
  const container = getContainer();
  const lifecycle = getLifecycle();

  if (!lifecycle) {
    throw new Error('Lifecycle manager not initialized');
  }

  const configService = container.resolveSync(ConfigServiceToken);
  const settings = configService.getSettings();

  logger.info('Starting background services...');

  // 恢复 devModeAutoApprove
  try {
    const { getSecureStorage } = await import('../services/core/secureStorage');
    const storage = getSecureStorage();
    const persistedValue = storage.get('settings.devModeAutoApprove');
    if (persistedValue !== undefined) {
      const enabled = persistedValue === 'true';
      const currentSettings = configService.getSettings();
      if (currentSettings.permissions.devModeAutoApprove !== enabled) {
        await configService.updateSettings({
          permissions: {
            ...currentSettings.permissions,
            devModeAutoApprove: enabled,
          },
        });
        logger.info('Restored devModeAutoApprove from persistent storage', { enabled });
      }
    }
  } catch (error) {
    logger.warn('Failed to restore devModeAutoApprove', { error: String(error) });
  }

  // 启动后台服务
  await lifecycle.startBackground();

  // 获取 GenerationManager
  const generationManager = container.resolveSync(GenerationManagerToken);

  // 初始化其他服务（保持原有逻辑）
  await initializeRemainingServices(configService, generationManager, settings);

  logger.info('Background services initialization complete');
}

/**
 * 初始化剩余服务（保持原有逻辑，渐进式迁移）
 */
async function initializeRemainingServices(
  configService: ConfigService,
  generationManager: GenerationManager,
  settings: ReturnType<ConfigService['getSettings']>
): Promise<void> {
  const mainWindow = getMainWindow();

  // CloudConfig → MCP → Skills 链式初始化
  initCloudConfigService()
    .then(async () => {
      const info = getCloudConfigService().getInfo();
      logger.info('CloudConfig initialized', { source: info.fromCloud ? 'cloud' : 'builtin', version: info.version });

      // Skills
      try {
        const skillRepoService = getSkillRepositoryService();
        await skillRepoService.initialize();
        logger.info('SkillRepositoryService initialized', {
          libraryCount: skillRepoService.getLocalLibraries().length,
        });

        skillRepoService.preloadRecommendedRepositories()
          .then(() => logger.info('Recommended skill repositories preloaded'))
          .catch((e) => logger.warn('Failed to preload recommended repositories', { error: String(e) }));
      } catch (e) {
        logger.warn('SkillRepositoryService initialization failed', { error: String(e) });
      }

      try {
        const skillDiscovery = getSkillDiscoveryService();
        await skillDiscovery.initialize(process.cwd());
        const stats = skillDiscovery.getStats();
        logger.info('SkillDiscovery initialized', stats);
      } catch (e) {
        logger.warn('SkillDiscovery initialization failed', { error: String(e) });
      }

      // MCP
      const mcpConfigs: MCPServerConfig[] = settings.mcp?.servers || [];
      logger.info('Initializing MCP servers...', { customCount: mcpConfigs.length });
      return initMCPClient(mcpConfigs);
    })
    .then(() => {
      const mcpClient = getMCPClient();
      const status = mcpClient.getStatus();
      const serverStates = mcpClient.getServerStates();
      const errorServers = serverStates.filter(s => s.status === 'error');

      logger.info('MCP initialized', {
        connected: status.connectedServers.join(', ') || 'none',
        toolCount: status.toolCount,
        errors: errorServers.map(s => `${s.config.name}: ${s.error}`).join('; ') || 'none',
      });

      if (mainWindow && errorServers.length > 0) {
        mainWindow.webContents.send(IPC_CHANNELS.MCP_EVENT, {
          type: 'connection_errors',
          data: errorServers.map(s => ({ server: s.config.name, error: s.error })),
        });
      }
    })
    .catch((error) => {
      logger.error('CloudConfig/MCP initialization failed', { error: String(error) });
    });

  // PromptService
  initPromptService()
    .then(() => {
      const info = getPromptsInfo();
      logger.info('PromptService initialized', { source: info.source, version: info.version || 'builtin' });
    })
    .catch((error) => {
      logger.warn('PromptService init failed', { error: String(error) });
    });

  // Plugin System
  initPluginSystem()
    .then(() => logger.info('Plugin system initialized'))
    .catch((error) => logger.error('Plugin system failed', error));

  // LogBridge
  await setupLogBridge();

  // Supabase-dependent services
  if (isSupabaseInitialized()) {
    setupSupabaseServices(configService, settings, mainWindow);
  }

  // Langfuse
  const langfusePublicKey = configService.getServiceApiKey('langfuse_public') || settings.langfuse?.publicKey;
  const langfuseSecretKey = configService.getServiceApiKey('langfuse_secret') || settings.langfuse?.secretKey;
  if (langfusePublicKey && langfuseSecretKey) {
    initLangfuse({
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL || settings.langfuse?.baseUrl || 'https://cloud.langfuse.com',
    });
    logger.info('Langfuse initialized');
  }

  // Update Service
  setupUpdateService(settings, mainWindow);

  // Agent Orchestrator
  await setupAgentOrchestrator(configService, generationManager, settings, mainWindow);

  // Session
  await initializeSession(settings);

  // Planning Service
  await initializePlanningService();
}

/**
 * 设置 Supabase 相关服务
 */
function setupSupabaseServices(
  configService: ConfigService,
  settings: ReturnType<ConfigService['getSettings']>,
  mainWindow: Electron.BrowserWindow | null
): void {
  logger.info('Supabase initialized');

  const authService = getAuthService();
  authService.addAuthChangeCallback((user) => {
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.AUTH_EVENT, {
        type: user ? 'signed_in' : 'signed_out',
        user,
      });
    }

    const syncService = getSyncService();
    if (user) {
      syncService.initialize().then(() => {
        syncService.startAutoSync(SYNC.SYNC_INTERVAL);
        logger.info('Auto-sync started');
      });

      if (user.isAdmin) {
        authService.getAccessToken().then((token) => {
          if (token) {
            configService.syncApiKeysFromCloud(token).then((result) => {
              if (result.success) {
                logger.info(`Admin API keys synced: ${result.syncedKeys.join(', ')}`);
              } else {
                logger.warn(`Failed to sync admin API keys: ${result.error}`);
              }
            });
          }
        });
      }
    } else {
      syncService.stopAutoSync();
      logger.info('Auto-sync stopped');
    }
  });

  authService.initialize()
    .then(() => logger.info('Auth service initialized'))
    .catch((error) => logger.error('Failed to initialize auth', error));

  try {
    const updateServerUrl = settings.cloudApi?.url || getCloudApiUrl();
    initUnifiedOrchestrator({
      cloudExecutor: {
        maxConcurrent: 3,
        defaultTimeout: CLOUD.CLOUD_EXECUTION_TIMEOUT,
        maxIterations: 20,
        apiEndpoint: updateServerUrl,
      },
    });
    logger.info('Unified orchestrator initialized');
  } catch (error) {
    logger.error('Failed to initialize unified orchestrator', error);
  }

  try {
    initCloudTaskService({});
    logger.info('CloudTaskService initialized');
  } catch (error) {
    logger.error('Failed to initialize CloudTaskService', error);
  }
}

/**
 * 设置更新服务
 */
function setupUpdateService(
  settings: ReturnType<ConfigService['getSettings']>,
  mainWindow: Electron.BrowserWindow | null
): void {
  try {
    const updateServerUrl = settings.cloudApi?.url || getCloudApiUrl();
    initUpdateService({
      updateServerUrl,
      checkInterval: UPDATE.CLOUD_CHECK_INTERVAL,
      autoDownload: false,
    });

    const updateService = getUpdateService();
    updateService.setProgressCallback((progress) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
          type: 'download_progress',
          data: progress,
        });
      }
    });

    updateService.setCompleteCallback((filePath) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
          type: 'download_complete',
          data: { filePath },
        });
      }
    });

    updateService.setErrorCallback((error) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
          type: 'download_error',
          data: { error: error.message },
        });
      }
    });

    setTimeout(() => {
      updateService.checkForUpdates().then((info) => {
        if (info.hasUpdate && mainWindow) {
          mainWindow.webContents.send(IPC_CHANNELS.UPDATE_EVENT, {
            type: 'update_available',
            data: info,
          });
        }
      }).catch((err) => {
        logger.error('Update check failed', err);
      });
    }, UPDATE.INITIAL_CHECK_DELAY);

    logger.info('Update service initialized', { server: updateServerUrl });
  } catch (error) {
    logger.error('Failed to initialize update service', error);
  }
}

/**
 * 设置 Agent Orchestrator
 */
async function setupAgentOrchestrator(
  configService: ConfigService,
  generationManager: GenerationManager,
  settings: ReturnType<ConfigService['getSettings']>,
  mainWindow: Electron.BrowserWindow | null
): Promise<void> {
  const turnStateBySession = new Map<string, {
    messageId: string;
    toolCalls: ToolCall[];
    content: string;
  }>();

  agentOrchestrator = new AgentOrchestrator({
    generationManager,
    configService,
    onEvent: async (event) => {
      logger.debug('onEvent called', { eventType: event.type });
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
      }

      const eventWithSession = event as typeof event & { sessionId?: string };
      const sessionId = eventWithSession.sessionId;

      if (!sessionId) {
        logger.warn('No sessionId in event, skipping message persistence');
        return;
      }

      const sessionManager = getSessionManager();

      if (event.type === 'message' && event.data?.role === 'assistant') {
        const message = event.data;
        let turnState = turnStateBySession.get(sessionId);
        if (!turnState) {
          turnState = { messageId: '', toolCalls: [], content: '' };
          turnStateBySession.set(sessionId, turnState);
        }

        if (message.toolCalls && message.toolCalls.length > 0) {
          turnState.toolCalls.push(...message.toolCalls);
        }
        if (message.content) {
          turnState.content = message.content;
        }

        try {
          if (!turnState.messageId) {
            turnState.messageId = message.id;
            await sessionManager.addMessage({
              ...message,
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          } else {
            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          }
        } catch (error) {
          logger.error('Failed to save/update assistant message', error);
        }
      }

      if (event.type === 'tool_call_end' && event.data) {
        const turnState = turnStateBySession.get(sessionId);
        const toolCallId = event.data.toolCallId;

        if (turnState?.messageId) {
          try {
            const idx = turnState.toolCalls.findIndex((tc) => tc.id === toolCallId);
            if (idx !== -1) {
              turnState.toolCalls[idx] = { ...turnState.toolCalls[idx], result: event.data };
            }
            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: [...turnState.toolCalls],
            });
          } catch (error) {
            logger.error('Failed to update tool call result', error);
          }
        }
      }

      if (event.type === 'turn_end' || event.type === 'agent_complete') {
        turnStateBySession.delete(sessionId);
      }

      if (event.type === 'task_complete' && event.data) {
        try {
          const session = await sessionManager.getSession(sessionId);
          if (session) {
            notificationService.notifyTaskComplete({
              sessionId: session.id,
              sessionTitle: session.title,
              summary: event.data.summary,
              duration: event.data.duration,
              toolsUsed: event.data.toolsUsed || [],
            });
          }
        } catch (error) {
          logger.error('Failed to send task complete notification', error);
        }
      }
    },
  });

  const defaultGenId = settings.generation.default || 'gen3';
  generationManager.switchGeneration(defaultGenId);
  logger.info('Generation set to', { genId: defaultGenId });

  const taskManager = getTaskManager();
  taskManager.initialize({
    generationManager,
    configService,
    planningService: undefined,
    onAgentEvent: (sessionId, event) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { ...event, sessionId });
      }
    },
  });
  logger.info('TaskManager initialized');
}

/**
 * 初始化会话
 */
async function initializeSession(settings: ReturnType<ConfigService['getSettings']>): Promise<void> {
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();

  const recentSession = await sessionManager.getMostRecentSession();

  if (recentSession && settings.session?.autoRestore !== false) {
    const restoredSession = await sessionManager.restoreSession(recentSession.id);
    currentSessionId = recentSession.id;
    logger.info('Restored session', { sessionId: recentSession.id });

    if (agentOrchestrator && restoredSession?.messages?.length) {
      agentOrchestrator.setMessages(restoredSession.messages);
      logger.info('Synced messages to orchestrator', { count: restoredSession.messages.length });
    }
  } else {
    const session = await sessionManager.createSession({
      title: 'New Session',
      generationId: settings.generation.default || 'gen3',
      modelConfig: {
        provider: settings.model?.provider || 'deepseek',
        model: settings.model?.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || 4096,
      },
      workingDirectory: agentOrchestrator?.getWorkingDirectory(),
    });
    sessionManager.setCurrentSession(session.id);
    currentSessionId = session.id;
    logger.info('Created new session', { sessionId: session.id });
  }

  memoryService.setContext(
    currentSessionId!,
    agentOrchestrator?.getWorkingDirectory() || undefined
  );
}

/**
 * 初始化规划服务
 */
async function initializePlanningService(): Promise<void> {
  if (!agentOrchestrator || !currentSessionId) return;

  const workingDir = agentOrchestrator.getWorkingDirectory();
  const effectiveWorkingDir = workingDir && workingDir !== '/'
    ? workingDir
    : app.getPath('userData');

  if (!effectiveWorkingDir) return;

  planningService = createPlanningService(effectiveWorkingDir, currentSessionId);
  logger.info('Planning service initialized', { path: effectiveWorkingDir });

  agentOrchestrator.setPlanningService(planningService);

  await sendPlanningStateToRenderer();
}

/**
 * 发送规划状态到渲染进程
 */
async function sendPlanningStateToRenderer(): Promise<void> {
  if (!planningService) return;

  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  try {
    const plan = await planningService.plan.read();
    const findings = await planningService.findings.getAll();
    const errors = await planningService.errors.getAll();

    const state: PlanningState = {
      plan,
      findings,
      errors,
    };

    mainWindow.webContents.send(IPC_CHANNELS.PLANNING_EVENT, {
      type: 'plan_updated',
      data: state,
    });
  } catch (error) {
    logger.error('Failed to send planning state', error);
  }
}

/**
 * 设置 LogBridge 命令处理器
 */
async function setupLogBridge(): Promise<void> {
  logBridge.setCommandHandler(async (command, params) => {
    logger.debug('LogBridge executing command', { command, params });

    const { browserService } = await import('../services/infra/browserService.js');

    switch (command) {
      case 'browser_action': {
        const action = params.action as string;
        if (!action) {
          return { success: false, error: 'Missing action parameter' };
        }

        try {
          switch (action) {
            case 'launch':
              await browserService.launch();
              return { success: true, output: 'Browser launched' };
            case 'close':
              await browserService.close();
              return { success: true, output: 'Browser closed' };
            case 'new_tab': {
              const tabId = await browserService.newTab(params.url as string);
              return { success: true, output: `New tab created: ${tabId}` };
            }
            case 'navigate':
              await browserService.navigate(params.url as string, params.tabId as string);
              return { success: true, output: `Navigated to ${params.url}` };
            case 'screenshot': {
              const result = await browserService.screenshot({
                fullPage: params.fullPage as boolean,
                tabId: params.tabId as string,
              });
              return {
                success: result.success,
                output: result.path ? `Screenshot saved: ${result.path}` : undefined,
                error: result.error,
              };
            }
            case 'get_content': {
              const content = await browserService.getPageContent(params.tabId as string);
              return {
                success: true,
                output: `URL: ${content.url}\nTitle: ${content.title}\n\n${content.text.substring(0, 2000)}...`,
              };
            }
            case 'click':
              await browserService.click(params.selector as string, params.tabId as string);
              return { success: true, output: `Clicked: ${params.selector}` };
            case 'type':
              await browserService.type(
                params.selector as string,
                params.text as string,
                params.tabId as string
              );
              return { success: true, output: `Typed into: ${params.selector}` };
            case 'get_logs': {
              const logs = browserService.logger.getLogsAsString(params.count as number || 20);
              return { success: true, output: logs };
            }
            case 'press_key':
              await browserService.pressKey(params.key as string, params.tabId as string);
              return { success: true, output: `Pressed key: ${params.key}` };
            case 'scroll':
              await browserService.scroll(
                params.direction as 'up' | 'down',
                params.amount as number,
                params.tabId as string
              );
              return { success: true, output: `Scrolled ${params.direction}` };
            default:
              return { success: false, error: `Unknown browser action: ${action}` };
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      case 'ping':
        return { success: true, output: 'pong' };

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  });

  logBridge.start()
    .then(() => {
      logger.info('LogBridge started', { port: logBridge.getPort() });
    })
    .catch((error) => {
      logger.error('LogBridge failed to start', error);
    });
}

// ----------------------------------------------------------------------------
// 关闭逻辑
// ----------------------------------------------------------------------------

/**
 * 优雅关闭所有服务
 */
export async function shutdownServices(): Promise<void> {
  const lifecycle = getLifecycle();
  if (lifecycle) {
    await lifecycle.shutdown();
  }

  // 关闭插件系统
  await shutdownPluginSystem();

  // 清理全局状态
  agentOrchestrator = null;
  currentSessionId = null;
  planningService = null;

  setLifecycle(null);
  setContainer(null);

  logger.info('All services shut down');
}
