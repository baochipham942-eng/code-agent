// ============================================================================
// Bootstrap - 服务初始化
// ============================================================================

import { app } from 'electron';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import {
  ConfigService,
  initDatabase,
  initSupabase,
  isSupabaseInitialized,
  getAuthService,
  getSyncService,
  initLangfuse,
} from '../services';
import { initUpdateService, getUpdateService } from '../services/cloud/updateService';
import { initMemoryService, getMemoryService } from '../memory/memoryService';
import { initMCPClient, getMCPClient, type MCPServerConfig } from '../mcp/mcpClient';
import { initPromptService, getPromptsInfo } from '../services/cloud/promptService';
import { initCloudConfigService, getCloudConfigService } from '../services/cloud';
import { initCloudTaskService } from '../cloud/cloudTaskService';
import { initUnifiedOrchestrator } from '../orchestrator';
import { logBridge } from '../mcp/logBridge.js';
import { initPluginSystem, shutdownPluginSystem } from '../plugins';
import { getMainWindow } from './window';
import { IPC_CHANNELS } from '../../shared/ipc';
import { SYNC, UPDATE, CLOUD, TOOL_CACHE } from '../../shared/constants';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { GenerationManager } from '../generation/generationManager';
import { createPlanningService, type PlanningService } from '../planning';
import { getSessionManager, notificationService } from '../services';
import { getTaskManager, type TaskManager } from '../task';
import type { PlanningState, ToolCall } from '../../shared/types';

const logger = createLogger('Bootstrap');

// Global state
let configService: ConfigService | null = null;
let agentOrchestrator: AgentOrchestrator | null = null;
let generationManager: GenerationManager | null = null;
let currentSessionId: string | null = null;
let planningService: PlanningService | null = null;

/**
 * 获取配置服务实例
 */
export function getConfigServiceInstance(): ConfigService | null {
  return configService;
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
  return generationManager;
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

/**
 * 核心服务初始化 - 必须在窗口创建前完成
 * 只包含 IPC handlers 依赖的最小服务集
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  // Initialize config service
  configService = new ConfigService();
  await configService.initialize();

  // Initialize database (SQLite persistence)
  await initDatabase();
  const userDataPath = app.getPath('userData');
  logger.info('Database initialized', { path: path.join(userDataPath, 'code-agent.db') });

  // Initialize memory service (needed for session management)
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: TOOL_CACHE.DEFAULT_TTL,
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  logger.info('Memory service initialized');

  // Initialize Supabase (MUST be in core services for auth IPC handlers)
  // Default Supabase config (public anon key, safe to hardcode)
  const DEFAULT_SUPABASE_URL = 'https://xepbunahzbmexsmmiqyq.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGJ1bmFoemJtZXhzbW1pcXlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODkyMTcsImV4cCI6MjA4NDA2NTIxN30.8swN1QdRX5vIjNyCLNhQTPAx-k2qxeS8EN4Ot2idY7w';

  const settings = configService.getSettings();
  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;

  initSupabase(supabaseUrl, supabaseAnonKey);
  logger.info('Supabase initialized (core)');

  logger.info('Core services initialized');
  return configService;
}

/**
 * 后台服务初始化 - 窗口创建后异步执行
 * 不阻塞用户交互
 */
export async function initializeBackgroundServices(): Promise<void> {
  if (!configService) {
    throw new Error('Core services not initialized');
  }

  logger.info('Starting background services...');

  const settings = configService.getSettings();

  // Restore devModeAutoApprove from persistent storage
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
    logger.warn('Failed to restore devModeAutoApprove from persistent storage', { error: String(error) });
  }

  // Initialize the rest of services
  await initializeServices();
}

/**
 * 完整服务初始化（后台执行）
 */
async function initializeServices(): Promise<void> {
  if (!configService) {
    throw new Error('Config service not initialized');
  }

  const settings = configService.getSettings();
  const mainWindow = getMainWindow();

  // Initialize CloudConfigService FIRST, then MCP (MCP depends on CloudConfig)
  // This is a chained initialization to avoid race conditions
  initCloudConfigService()
    .then(() => {
      const info = getCloudConfigService().getInfo();
      logger.info('CloudConfig initialized', { source: info.fromCloud ? 'cloud' : 'builtin', version: info.version });

      // Now initialize MCP client AFTER CloudConfig is ready
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

      // Notify renderer about MCP status (for UI display)
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

  // Initialize PromptService ASYNC (non-blocking, independent)
  initPromptService()
    .then(() => {
      const info = getPromptsInfo();
      logger.info('PromptService initialized', { source: info.source, version: info.version || 'builtin' });
    })
    .catch((error) => {
      logger.warn('PromptService init failed (using builtin)', { error: String(error) });
    });

  // Initialize Plugin System ASYNC (non-blocking)
  initPluginSystem()
    .then(() => {
      logger.info('Plugin system initialized');
    })
    .catch((error) => {
      logger.error('Plugin system failed to initialize (non-blocking)', error);
    });

  // Setup LogBridge command handler
  await setupLogBridge();

  // Initialize Supabase-dependent services (Supabase already initialized in core services)
  if (isSupabaseInitialized()) {
    logger.info('Supabase initialized');

    // Set up auth change callback
    const authService = getAuthService();
    authService.addAuthChangeCallback((user) => {
      if (mainWindow) {
        mainWindow.webContents.send(IPC_CHANNELS.AUTH_EVENT, {
          type: user ? 'signed_in' : 'signed_out',
          user,
        });
      }

      // Start/stop sync based on auth state
      const syncService = getSyncService();
      if (user) {
        syncService.initialize().then(() => {
          syncService.startAutoSync(SYNC.SYNC_INTERVAL);
          logger.info('Auto-sync started');
        });
      } else {
        syncService.stopAutoSync();
        logger.info('Auto-sync stopped');
      }
    });

    // Initialize auth (restore session) - NON-BLOCKING
    authService.initialize()
      .then(() => {
        logger.info('Auth service initialized');
      })
      .catch((error) => {
        logger.error('Failed to initialize auth (non-blocking)', error);
      });

    // Initialize unified orchestrator (cloud task execution)
    try {
      const updateServerUrl = process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
      initUnifiedOrchestrator({
        cloudExecutor: {
          maxConcurrent: 3,
          defaultTimeout: CLOUD.CLOUD_EXECUTION_TIMEOUT,
          maxIterations: 20,
          apiEndpoint: updateServerUrl,
        },
      });
      logger.info('Unified orchestrator initialized');
    } catch (error: unknown) {
      logger.error('Failed to initialize unified orchestrator', error);
    }

    // Initialize cloud task service
    try {
      initCloudTaskService({});
      logger.info('CloudTaskService initialized');
    } catch (error: unknown) {
      logger.error('Failed to initialize CloudTaskService', error);
    }
  } else {
    logger.info('Supabase not configured (offline mode)');
  }

  // Initialize Langfuse (analytics, if configured)
  // Priority: configService > env > settings
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

  // Initialize update service
  try {
    const updateServerUrl = process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
    initUpdateService({
      updateServerUrl,
      checkInterval: UPDATE.CLOUD_CHECK_INTERVAL,
      autoDownload: false,
    });

    // Set up update event callbacks
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

    // Start auto-check for updates (after a delay to not block startup)
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
  } catch (error: unknown) {
    logger.error('Failed to initialize update service', error);
  }

  // Initialize generation manager
  generationManager = new GenerationManager();

  // Track current assistant message for aggregating multiple messages in a turn
  // This prevents creating multiple database records for a single agent turn
  let currentTurnMessageId: string | null = null;
  let accumulatedToolCalls: ToolCall[] = [];
  let accumulatedContent = '';

  // Initialize agent orchestrator
  agentOrchestrator = new AgentOrchestrator({
    generationManager,
    configService: configService!,
    onEvent: async (event) => {
      logger.debug('onEvent called', { eventType: event.type });
      if (mainWindow) {
        logger.debug('Sending event to renderer', { eventType: event.type });
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
      } else {
        logger.warn('mainWindow is null, cannot send event');
      }

      // Aggregate assistant messages within a single turn
      // Instead of creating a new DB record for each message event,
      // we accumulate them and only persist one aggregated message per turn
      if (event.type === 'message' && event.data?.role === 'assistant') {
        const message = event.data;

        // Accumulate tool calls if present
        if (message.toolCalls && message.toolCalls.length > 0) {
          accumulatedToolCalls.push(...message.toolCalls);
        }

        // Accumulate content if present
        if (message.content) {
          accumulatedContent = message.content; // Use latest content (final response)
        }

        try {
          const sessionManager = getSessionManager();

          if (!currentTurnMessageId) {
            // First message in this turn - create new record
            currentTurnMessageId = message.id;
            await sessionManager.addMessage({
              ...message,
              toolCalls: accumulatedToolCalls.length > 0 ? [...accumulatedToolCalls] : undefined,
              content: accumulatedContent,
            });
          } else {
            // Subsequent message in this turn - update existing record
            await sessionManager.updateMessage(currentTurnMessageId, {
              toolCalls: accumulatedToolCalls.length > 0 ? [...accumulatedToolCalls] : undefined,
              content: accumulatedContent,
            });
          }
        } catch (error) {
          logger.error('Failed to save/update assistant message', error);
        }
      }

      // Update tool call results
      if (event.type === 'tool_call_end' && currentTurnMessageId && event.data) {
        try {
          // Update accumulated tool calls with results
          const toolCallId = event.data.toolCallId;
          const idx = accumulatedToolCalls.findIndex((tc) => tc.id === toolCallId);
          if (idx !== -1) {
            accumulatedToolCalls[idx] = { ...accumulatedToolCalls[idx], result: event.data };
          }

          // Persist the update
          const sessionManager = getSessionManager();
          await sessionManager.updateMessage(currentTurnMessageId, {
            toolCalls: [...accumulatedToolCalls],
          });
        } catch (error) {
          logger.error('Failed to update tool call result', error);
        }
      }

      // Reset turn state when turn ends or agent completes
      if (event.type === 'turn_end' || event.type === 'agent_complete') {
        currentTurnMessageId = null;
        accumulatedToolCalls = [];
        accumulatedContent = '';
      }

      // Send desktop notification on task complete
      if (event.type === 'task_complete' && event.data) {
        try {
          const sessionManager = getSessionManager();
          const session = await sessionManager.getCurrentSession();
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

  // Set default generation
  const defaultGenId = settings.generation.default || 'gen3';
  generationManager.switchGeneration(defaultGenId);
  logger.info('Generation set to', { genId: defaultGenId });

  // Initialize TaskManager (Wave 5: 多任务并行)
  const taskManager = getTaskManager();
  taskManager.initialize({
    generationManager,
    configService: configService!,
    planningService: undefined, // Will be set after planningService is initialized
    onAgentEvent: (sessionId, event) => {
      if (mainWindow) {
        // Send event with sessionId prefix for multi-session support
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, { ...event, sessionId });
      }
    },
  });
  logger.info('TaskManager initialized');

  // Auto-restore or create session
  logger.info('Initializing session...');
  await initializeSession(settings);
  logger.info('Session initialized');

  // Initialize planning service for Gen 3+
  logger.info('Initializing planning service...');
  await initializePlanningService();
  logger.info('Planning service initialized');

  logger.info('Background services initialization complete');
}

/**
 * 初始化会话
 */
async function initializeSession(settings: any): Promise<void> {
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();

  // Try to restore most recent session or create new one
  const recentSession = await sessionManager.getMostRecentSession();

  if (recentSession && settings.session?.autoRestore !== false) {
    await sessionManager.restoreSession(recentSession.id);
    currentSessionId = recentSession.id;
    logger.info('Restored session', { sessionId: recentSession.id });
  } else {
    const session = await sessionManager.createSession({
      title: 'New Session',
      generationId: settings.generation.default || 'gen3',
      modelConfig: {
        provider: settings.model?.provider || 'deepseek',
        model: settings.model?.model || 'deepseek-chat',
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || 4096,
      },
      workingDirectory: agentOrchestrator?.getWorkingDirectory(),
    });
    sessionManager.setCurrentSession(session.id);
    currentSessionId = session.id;
    logger.info('Created new session', { sessionId: session.id });
  }

  // Set memory service context
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
  logger.debug('initializePlanningService', { workingDir });

  // Fallback to app userData if workingDir is '/' (packaged Electron app issue)
  const effectiveWorkingDir = workingDir && workingDir !== '/'
    ? workingDir
    : app.getPath('userData');

  logger.debug('initializePlanningService', { effectiveWorkingDir });

  if (!effectiveWorkingDir) return;

  planningService = createPlanningService(effectiveWorkingDir, currentSessionId);
  logger.info('Planning service initialized', { path: effectiveWorkingDir });

  // Pass planning service to agent orchestrator
  agentOrchestrator.setPlanningService(planningService);

  // Send initial planning state to renderer
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

    // Import browser service dynamically to avoid circular dependencies
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

  // Start Log Bridge server in background
  logBridge.start()
    .then(() => {
      logger.info('LogBridge started', { port: logBridge.getPort() });
    })
    .catch((error) => {
      logger.error('LogBridge failed to start (non-blocking)', error);
    });
}
