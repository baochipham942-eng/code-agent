// ============================================================================
// Phase 2: Background Services - 窗口创建后异步执行，不阻塞用户交互
// ============================================================================

import { app, BrowserWindow } from '../platform';
import { createLogger } from '../services/infra/logger';
import {
  ConfigService,
  initSupabase,
  isSupabaseInitialized,
  getAuthService,
  getSyncService,
  initLangfuse,
} from '../services';
import { initUpdateService, getUpdateService } from '../services/cloud/updateService';
import { initMCPClient, getMCPClient, type MCPServerConfig } from '../mcp/mcpClient';
import { initPromptService, getPromptsInfo } from '../services/cloud/promptService';
import { initCloudConfigService, getCloudConfigService } from '../services/cloud';
import { initCloudTaskService } from '../cloud/cloudTaskService';
import { initUnifiedOrchestrator } from '../orchestrator';
import { initDesktopActivityUnderstandingService, initWorkspaceArtifactIndexService } from '../memory';
import { logBridge } from '../mcp/logBridge.js';
import { initPluginSystem } from '../plugins';
import { initDAGEventBridge } from '../scheduler';
import { initCronService, getCronService, initHeartbeatService, getHeartbeatService, HeartbeatTaskLoader } from '../cron';
import { getFileCheckpointService } from '../services/checkpoint';
import { getSkillDiscoveryService, getSkillRepositoryService, initSkillWatcher } from '../services/skills';
import { getMainWindow } from './window';
import { detectCodexCLI } from '../tools/shell/codexSandbox';
import { SYNC, UPDATE, CLOUD, getCloudApiUrl, DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } from '../../shared/constants';
import { loadSoul, watchSoulFiles } from '../prompts/soulLoader';
import { initEventBridge } from '../events';
// Event channel constants (post-IPC_CHANNELS deprecation)
const EVENT_CHANNELS = {
  MCP: 'mcp:event',
  AUTH: 'auth:event',
  UPDATE: 'update:event',
} as const;

const logger = createLogger('Bootstrap:Background');

/**
 * Initialize cloud config, skills discovery, MCP, and codex detection.
 * These are chained because skills and MCP depend on CloudConfig.
 */
async function initializeCloudAndMCP(configService: ConfigService, mainWindow: BrowserWindow | null): Promise<void> {
  await initCloudConfigService();

  const info = getCloudConfigService().getInfo();
  logger.info('CloudConfig initialized', { source: info.fromCloud ? 'cloud' : 'builtin', version: info.version });

  // Initialize SkillRepositoryService AFTER CloudConfig is ready
  try {
    const skillRepoService = getSkillRepositoryService();
    await skillRepoService.initialize();
    logger.info('SkillRepositoryService initialized', {
      libraryCount: skillRepoService.getLocalLibraries().length,
    });

    // Preload recommended repositories in background (non-blocking)
    skillRepoService.preloadRecommendedRepositories()
      .then(() => logger.info('Recommended skill repositories preloaded'))
      .catch((preloadError) => logger.warn('Failed to preload recommended repositories', { error: String(preloadError) }));
  } catch (repoError) {
    logger.warn('SkillRepositoryService initialization failed (non-blocking)', { error: String(repoError) });
  }

  // Initialize SkillDiscoveryService AFTER CloudConfig and SkillRepositoryService are ready
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

    // Initialize SkillWatcher for hot-reload
    initSkillWatcher(process.cwd())
      .then((watcher) => {
        watcher.on('reloaded', (reloadStats) => {
          logger.info('Skills hot-reloaded', { total: reloadStats.total });
          if (mainWindow) {
            mainWindow.webContents.send(EVENT_CHANNELS.MCP, {
              type: 'server_connected',
              data: [{ server: 'skills', error: undefined }],
            });
          }
        });
        logger.info('SkillWatcher initialized', { watchCount: watcher.getWatchCount() });
      })
      .catch((watchError) => logger.warn('SkillWatcher initialization failed (non-blocking)', { error: String(watchError) }));
  } catch (skillError) {
    logger.warn('SkillDiscovery initialization failed (non-blocking)', { error: String(skillError) });
  }

  // Codex CLI auto-discovery + MCP injection
  const settings = configService.getSettings();
  const mcpConfigs: MCPServerConfig[] = settings.mcp?.servers || [];
  try {
    const codexPath = await detectCodexCLI();
    if (codexPath) {
      const current = configService.getSettings();
      if (current.codex?.detectedPath !== codexPath) {
        await configService.updateSettings({
          codex: { ...current.codex, sandboxEnabled: current.codex?.sandboxEnabled ?? false, crossVerifyEnabled: current.codex?.crossVerifyEnabled ?? false, detectedPath: codexPath },
        });
      }
      const hasCodexServer = mcpConfigs.some(s => s.name === 'codex');
      const sandboxEnabled = settings.codex?.sandboxEnabled || settings.codex?.crossVerifyEnabled;
      if (sandboxEnabled && !hasCodexServer) {
        mcpConfigs.push({
          name: 'codex',
          command: codexPath,
          args: ['mcp-server'],
          enabled: true,
          lazyLoad: false,
        });
        logger.info('Auto-injected Codex MCP server', { path: codexPath });
      }
    } else {
      const current = configService.getSettings();
      if (current.codex?.detectedPath) {
        configService.updateSettings({
          codex: { ...current.codex, detectedPath: null },
        });
      }
    }
  } catch (codexError) {
    logger.warn('Codex CLI detection failed (non-blocking)', { error: String(codexError) });
  }

  // Now initialize MCP client AFTER CloudConfig is ready
  logger.info('Initializing MCP servers...', { customCount: mcpConfigs.length });
  await initMCPClient(mcpConfigs);

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
    mainWindow.webContents.send(EVENT_CHANNELS.MCP, {
      type: 'connection_errors',
      data: errorServers.map(s => ({ server: s.config.name, error: s.error })),
    });
  }
}

/**
 * Initialize Supabase-dependent services: auth, sync, cloud orchestrator, cloud tasks
 */
function initializeSupabaseServices(configService: ConfigService, mainWindow: BrowserWindow | null): void {
  if (!isSupabaseInitialized()) {
    logger.info('Supabase not configured (offline mode)');
    return;
  }

  logger.info('Supabase initialized');
  const settings = configService.getSettings();

  // Set up auth change callback
  const authService = getAuthService();
  authService.addAuthChangeCallback((user) => {
    if (mainWindow) {
      mainWindow.webContents.send(EVENT_CHANNELS.AUTH, {
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
    .then(() => logger.info('Auth service initialized'))
    .catch((error) => logger.error('Failed to initialize auth (non-blocking)', error));

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
}

/**
 * Initialize update service and auto-check for updates
 */
function initializeUpdateService(configService: ConfigService, mainWindow: BrowserWindow | null): void {
  const settings = configService.getSettings();

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
        mainWindow.webContents.send(EVENT_CHANNELS.UPDATE, {
          type: 'download_progress',
          data: progress,
        });
      }
    });

    updateService.setCompleteCallback((filePath) => {
      if (mainWindow) {
        mainWindow.webContents.send(EVENT_CHANNELS.UPDATE, {
          type: 'download_complete',
          data: { filePath },
        });
      }
    });

    updateService.setErrorCallback((error) => {
      if (mainWindow) {
        mainWindow.webContents.send(EVENT_CHANNELS.UPDATE, {
          type: 'download_error',
          data: { error: error.message },
        });
      }
    });

    // Start auto-check for updates (after a delay to not block startup)
    setTimeout(() => {
      updateService.checkForUpdates().then((info) => {
        if (info.hasUpdate && mainWindow) {
          mainWindow.webContents.send(EVENT_CHANNELS.UPDATE, {
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
}

/**
 * Setup LogBridge command handler for browser service integration
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

  // Start Log Bridge server in background
  logBridge.start()
    .then(() => logger.info('LogBridge started', { port: logBridge.getPort() }))
    .catch((error) => logger.error('LogBridge failed to start (non-blocking)', error));
}

/**
 * 后台服务初始化 - 窗口创建后异步执行
 * 不阻塞用户交互。Returns after all background services are set up.
 *
 * Note: This initializes infra services only. Agent runtime and session
 * restoration are handled by createAgentRuntime and restoreSession.
 */
export async function initializeBackgroundInfra(configService: ConfigService): Promise<void> {
  logger.info('Starting background infrastructure services...');

  const settings = configService.getSettings();
  const mainWindow = getMainWindow();

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

  // Initialize Supabase (延迟初始化，从核心服务移到这里)
  const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;
  initSupabase(supabaseUrl, supabaseAnonKey);
  logger.info('Supabase initialized (background)');

  // CloudConfig → Skills → MCP (chained, non-blocking)
  initializeCloudAndMCP(configService, mainWindow)
    .catch((error) => logger.error('CloudConfig/MCP initialization failed', { error: String(error) }));

  // Initialize PromptService ASYNC (non-blocking, independent)
  initPromptService()
    .then(() => {
      const info = getPromptsInfo();
      logger.info('PromptService initialized', { source: info.source, version: info.version || 'builtin' });
    })
    .catch((error) => logger.warn('PromptService init failed (using builtin)', { error: String(error) }));

  // Initialize Plugin System ASYNC (non-blocking)
  initPluginSystem()
    .then(() => logger.info('Plugin system initialized'))
    .catch((error) => logger.error('Plugin system failed to initialize (non-blocking)', error));

  // Initialize EventBus + EventBridge (global event system)
  try {
    initEventBridge(() => getMainWindow()).start();
    logger.info('EventBus + EventBridge initialized');
  } catch (error) {
    logger.warn('EventBus initialization failed (non-blocking)', { error: String(error) });
  }

  // Initialize ComboRecorder (subscribes to tool_call_end events)
  try {
    const { getComboRecorder } = await import('../services/skills/comboRecorder');
    getComboRecorder().init();
    logger.info('ComboRecorder initialized');
  } catch (error) {
    logger.warn('ComboRecorder initialization failed (non-blocking)', { error: String(error) });
  }

  initDesktopActivityUnderstandingService()
    .then(() => logger.info('DesktopActivityUnderstandingService initialized'))
    .catch((error) => logger.warn('DesktopActivityUnderstandingService initialization failed (non-blocking)', {
      error: String(error),
    }));

  initWorkspaceArtifactIndexService()
    .then(() => logger.info('WorkspaceArtifactIndexService initialized'))
    .catch((error) => logger.warn('WorkspaceArtifactIndexService initialization failed (non-blocking)', {
      error: String(error),
    }));

  // Initialize DAG Event Bridge
  try {
    initDAGEventBridge();
    logger.info('DAG event bridge initialized');
  } catch (error) {
    logger.warn('DAG event bridge initialization failed (non-blocking)', { error: String(error) });
  }

  // Initialize Cron Service
  initCronService()
    .then(() => {
      const stats = getCronService().getStats();
      logger.info('CronService initialized', { jobs: stats.totalJobs, active: stats.activeJobs });
    })
    .catch((error) => logger.warn('CronService initialization failed (non-blocking)', { error: String(error) }));

  // Initialize Heartbeat Service
  initHeartbeatService()
    .then(() => {
      const stats = getHeartbeatService().getStats();
      logger.info('HeartbeatService initialized', { total: stats.total, healthy: stats.healthy });
    })
    .catch((error) => logger.warn('HeartbeatService initialization failed (non-blocking)', { error: String(error) }));

  // Initialize HeartbeatTaskLoader
  initCronService()
    .then(async () => {
      const workingDir = app.isPackaged ? process.cwd() : process.env.CODE_AGENT_WORKING_DIR || process.cwd();
      const heartbeatLoader = new HeartbeatTaskLoader({ workingDirectory: workingDir, cronService: getCronService() });
      await heartbeatLoader.loadFromFile();
      heartbeatLoader.watchFile();
      logger.info('HeartbeatTaskLoader initialized');
    })
    .catch((error) => logger.warn('HeartbeatTaskLoader initialization failed (non-blocking)', { error: String(error) }));

  // 清理过期检查点（启动时执行一次）
  getFileCheckpointService().cleanup().then(count => {
    if (count > 0) logger.info('Cleaned up expired file checkpoints', { count });
  }).catch(err => logger.warn('Failed to cleanup file checkpoints', { error: err }));

  // Setup LogBridge command handler
  await setupLogBridge();

  // Supabase-dependent services
  initializeSupabaseServices(configService, mainWindow);

  // Langfuse (analytics)
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

  // Update service
  initializeUpdateService(configService, mainWindow);

  // Load soul/profile personality
  try {
    const workingDir = app.isPackaged ? process.cwd() : process.env.CODE_AGENT_WORKING_DIR || process.cwd();
    loadSoul(workingDir);
    watchSoulFiles(workingDir);
    logger.info('Soul/Profile loader initialized');
  } catch (error) {
    logger.warn('Soul/Profile loader failed (using default identity)', { error: String(error) });
  }

  // 模型一致性校验（非阻塞，仅日志告警）
  try {
    const { validateModelConsistency } = await import('../model/modelValidator');
    validateModelConsistency();
  } catch (err) {
    logger.debug('Model consistency check skipped', err);
  }

  logger.info('Background infrastructure services initialized');
}
