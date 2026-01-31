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
import { initDAGEventBridge } from '../scheduler';
import { initCronService, getCronService, initHeartbeatService, getHeartbeatService } from '../cron';
import { initFileCheckpointService, getFileCheckpointService } from '../services/checkpoint';
import { getSkillDiscoveryService, getSkillRepositoryService } from '../services/skills';
import { getMainWindow } from './window';
import { getChannelManager } from '../channels';
import { initChannelAgentBridge, getChannelAgentBridge } from '../channels/channelAgentBridge';
import { IPC_CHANNELS } from '../../shared/ipc';
import { SYNC, UPDATE, CLOUD, TOOL_CACHE, getCloudApiUrl, DEFAULT_MODELS } from '../../shared/constants';
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
 *
 * 性能优化：
 * 1. ConfigService 和 Database 并行初始化
 * 2. Supabase 延迟到后台服务阶段（authService 支持离线模式）
 * 3. MemoryService 在数据库就绪后初始化
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  const startTime = Date.now();

  // 并行初始化 ConfigService 和 Database（无依赖关系）
  configService = new ConfigService();

  const [, dbResult] = await Promise.all([
    configService.initialize(),
    initDatabase(),
  ]);

  const userDataPath = app.getPath('userData');
  logger.info('Config & Database initialized (parallel)', {
    path: path.join(userDataPath, 'code-agent.db'),
    elapsed: Date.now() - startTime,
  });

  // Initialize memory service (depends on database)
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: TOOL_CACHE.DEFAULT_TTL,
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  logger.info('Memory service initialized');

  // 初始化文件检查点服务
  initFileCheckpointService();
  logger.info('File checkpoint service initialized');

  // NOTE: Supabase 延迟到 initializeBackgroundServices() 中初始化
  // authService.initialize() 支持 Supabase 未就绪时从本地缓存读取用户

  logger.info('Core services initialized', { totalElapsed: Date.now() - startTime });
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

  // Initialize Supabase (延迟初始化，从核心服务移到这里)
  // authService.initialize() 支持 Supabase 未初始化时从本地缓存读取用户
  const DEFAULT_SUPABASE_URL = 'https://xepbunahzbmexsmmiqyq.supabase.co';
  const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhlcGJ1bmFoemJtZXhzbW1pcXlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0ODkyMTcsImV4cCI6MjA4NDA2NTIxN30.8swN1QdRX5vIjNyCLNhQTPAx-k2qxeS8EN4Ot2idY7w';

  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;

  initSupabase(supabaseUrl, supabaseAnonKey);
  logger.info('Supabase initialized (background)');

  // Initialize CloudConfigService FIRST, then MCP and Skills (they depend on CloudConfig)
  // This is a chained initialization to avoid race conditions
  initCloudConfigService()
    .then(async () => {
      const info = getCloudConfigService().getInfo();
      logger.info('CloudConfig initialized', { source: info.fromCloud ? 'cloud' : 'builtin', version: info.version });

      // Initialize SkillRepositoryService AFTER CloudConfig is ready
      // This handles local skill library downloads and management
      try {
        const skillRepoService = getSkillRepositoryService();
        await skillRepoService.initialize();
        logger.info('SkillRepositoryService initialized', {
          libraryCount: skillRepoService.getLocalLibraries().length,
        });

        // Preload recommended repositories in background (non-blocking)
        skillRepoService.preloadRecommendedRepositories()
          .then(() => {
            logger.info('Recommended skill repositories preloaded');
          })
          .catch((preloadError) => {
            logger.warn('Failed to preload recommended repositories', { error: String(preloadError) });
          });
      } catch (repoError) {
        logger.warn('SkillRepositoryService initialization failed (non-blocking)', { error: String(repoError) });
      }

      // Initialize SkillDiscoveryService AFTER CloudConfig and SkillRepositoryService are ready
      // Skills depend on CloudConfig for builtin skills
      try {
        const skillDiscovery = getSkillDiscoveryService();
        await skillDiscovery.initialize(process.cwd());
        const stats = skillDiscovery.getStats();
        logger.info('SkillDiscovery initialized', {
          total: stats.total,
          builtin: stats.bySource.builtin,
          user: stats.bySource.user,
          project: stats.bySource.project,
          library: stats.bySource.library,
        });
      } catch (skillError) {
        logger.warn('SkillDiscovery initialization failed (non-blocking)', { error: String(skillError) });
      }

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

  // Initialize DAG Event Bridge (forwards DAG events to renderer for visualization)
  try {
    initDAGEventBridge();
    logger.info('DAG event bridge initialized');
  } catch (error) {
    logger.warn('DAG event bridge initialization failed (non-blocking)', { error: String(error) });
  }

  // Initialize Cron Service (scheduled tasks)
  initCronService()
    .then(() => {
      const stats = getCronService().getStats();
      logger.info('CronService initialized', { jobs: stats.totalJobs, active: stats.activeJobs });
    })
    .catch((error) => {
      logger.warn('CronService initialization failed (non-blocking)', { error: String(error) });
    });

  // Initialize Heartbeat Service (health monitoring)
  initHeartbeatService()
    .then(() => {
      const stats = getHeartbeatService().getStats();
      logger.info('HeartbeatService initialized', { total: stats.total, healthy: stats.healthy });
    })
    .catch((error) => {
      logger.warn('HeartbeatService initialization failed (non-blocking)', { error: String(error) });
    });

  // 清理过期检查点（启动时执行一次）
  getFileCheckpointService().cleanup().then(count => {
    if (count > 0) {
      logger.info('Cleaned up expired file checkpoints', { count });
    }
  }).catch(err => {
    logger.warn('Failed to cleanup file checkpoints', { error: err });
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

        // Auto-sync API keys for admin users
        if (user.isAdmin) {
          authService.getAccessToken().then((token) => {
            if (token && configService) {
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
    const updateServerUrl = settings.cloudApi?.url || getCloudApiUrl();
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
  // Use a Map to support multiple concurrent sessions
  const turnStateBySession = new Map<string, {
    messageId: string;
    toolCalls: ToolCall[];
    content: string;
  }>();

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

      // 使用事件携带的 sessionId（由 AgentOrchestrator 在发送消息时注入）
      // 这样即使用户在执行过程中切换会话，事件也会写入正确的会话
      const eventWithSession = event as typeof event & { sessionId?: string };
      const sessionId = eventWithSession.sessionId;

      if (!sessionId) {
        logger.warn('No sessionId in event, skipping message persistence');
        return;
      }

      const sessionManager = getSessionManager();

      // Aggregate assistant messages within a single turn
      // Instead of creating a new DB record for each message event,
      // we accumulate them and only persist one aggregated message per turn
      if (event.type === 'message' && event.data?.role === 'assistant') {
        const message = event.data;

        // Get or create turn state for this session
        let turnState = turnStateBySession.get(sessionId);
        if (!turnState) {
          turnState = { messageId: '', toolCalls: [], content: '' };
          turnStateBySession.set(sessionId, turnState);
        }

        // Accumulate tool calls if present
        if (message.toolCalls && message.toolCalls.length > 0) {
          turnState.toolCalls.push(...message.toolCalls);
        }

        // Accumulate content if present
        if (message.content) {
          turnState.content = message.content; // Use latest content (final response)
        }

        try {
          if (!turnState.messageId) {
            // First message in this turn - create new record
            turnState.messageId = message.id;
            await sessionManager.addMessage({
              ...message,
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          } else {
            // Subsequent message in this turn - update existing record
            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          }
        } catch (error) {
          logger.error('Failed to save/update assistant message', error);
        }
      }

      // Update tool call results
      if (event.type === 'tool_call_end' && event.data) {
        const turnState = turnStateBySession.get(sessionId);
        const toolCallId = event.data.toolCallId;

        if (!turnState) {
          logger.warn('tool_call_end: turnState not found', { sessionId, toolCallId });
        } else if (!turnState.messageId) {
          logger.warn('tool_call_end: messageId not set', { sessionId, toolCallId });
        } else {
          try {
            // Update accumulated tool calls with results
            const idx = turnState.toolCalls.findIndex((tc) => tc.id === toolCallId);
            if (idx !== -1) {
              turnState.toolCalls[idx] = { ...turnState.toolCalls[idx], result: event.data };
              logger.debug('tool_call_end: updated result', { toolCallId, idx, hasOutput: !!event.data.output });
            } else {
              logger.warn('tool_call_end: toolCall not found in turnState', {
                toolCallId,
                availableIds: turnState.toolCalls.map(tc => tc.id),
              });
            }

            // Persist the update
            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: [...turnState.toolCalls],
            });
          } catch (error) {
            logger.error('Failed to update tool call result', error);
          }
        }
      }

      // Reset turn state when turn ends or agent completes
      if (event.type === 'turn_end' || event.type === 'agent_complete') {
        turnStateBySession.delete(sessionId);
      }

      // Send desktop notification on task complete
      if (event.type === 'task_complete' && event.data) {
        try {
          // 使用事件携带的 sessionId 获取会话信息
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

  // Initialize Channel Agent Bridge (multi-channel access: HTTP API, Feishu, etc.)
  // Must be after agentOrchestrator and generationManager are created
  const channelBridge = initChannelAgentBridge({
    getOrchestrator: () => agentOrchestrator,
    generationManager: generationManager,
    configService: configService!,
  });
  channelBridge.initialize()
    .then(() => {
      const channelManager = getChannelManager();
      logger.info('Channel Agent Bridge initialized', {
        pluginCount: channelManager.getRegisteredPlugins().length,
        accountCount: channelManager.getAllAccounts().length,
      });
    })
    .catch((error) => {
      logger.error('Channel Agent Bridge failed to initialize (non-blocking)', error);
    });

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
    const restoredSession = await sessionManager.restoreSession(recentSession.id);
    currentSessionId = recentSession.id;
    logger.info('Restored session', { sessionId: recentSession.id });

    // 同步消息历史到 orchestrator，否则模型看不到之前的对话上下文
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
