// ============================================================================
// Phase 2: Background Services - 窗口创建后异步执行，不阻塞用户交互
// ============================================================================

import { app, AppWindow } from '../platform';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../services/infra/logger';
import {
  ConfigService,
  initSupabaseFromSettings,
  isSupabaseInitialized,
  getAuthService,
  getSyncService,
  initLangfuse,
} from '../services';
import { ensureUpdateServiceInitialized } from './updateServiceBootstrap';
import { getTelemetryUploaderService } from '../telemetry/telemetryUploaderService';
import { getPostHogDistinctId, setCurrentDistinctId, identifyNode } from '../observability/posthogNode';
import { initMCPClient, getMCPClient, type MCPServerConfig } from '../mcp/mcpClient';
import { initPromptService, getPromptsInfo } from '../services/cloud/promptService';
import { initCloudConfigService, getCloudConfigService } from '../services/cloud';
import { initDesktopActivityUnderstandingService } from '../desktop/desktopActivityUnderstandingService';
import { initWorkspaceArtifactIndexService } from '../desktop/workspaceArtifactIndexService';
import { logBridge } from '../mcp/logBridge.js';
import { TaskStatusProvider } from '../mcp/taskStatusProvider.js';
import { getDatabase } from '../services/core/databaseService';
import { getProjectService } from '../services/project/projectService';
import { getTaskManager } from '../task/TaskManager';
import { initPluginSystem } from '../plugins';
import { initDAGEventBridge, getDAGScheduler } from '../scheduler';
import {
  getPredefinedAgent,
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
} from '../agent/agentDefinition';
import { initAgentRegistry } from '../agent/agentRegistry';
import { initCronService, getCronService, initHeartbeatService, getHeartbeatService, HeartbeatTaskLoader } from '../cron';
import { getFileCheckpointService } from '../services/checkpoint';
import { getSkillDiscoveryService, getSkillRepositoryService, initSkillWatcher } from '../services/skills';
import { getMainWindow } from './window';
import { SYNC, MEMORY_CONSOLIDATION } from '../../shared/constants';
import { loadSoul, watchSoulFiles } from '../prompts/soulLoader';
import { initEventBridge } from '../services/eventing';
// Event channel constants (post-IPC_CHANNELS deprecation)
const EVENT_CHANNELS = {
  MCP: 'mcp:event',
  AUTH: 'auth:event',
  UPDATE: 'update:event',
} as const;

const logger = createLogger('Bootstrap:Background');

function resolveDirIfUsable(dir: string | undefined): string | null {
  if (!dir) return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  try {
    return fs.statSync(trimmed).isDirectory() ? trimmed : null;
  } catch {
    return null;
  }
}

function getDesktopBootstrapWorkingDirectory(configService?: ConfigService): string {
  const configured = process.env.CODE_AGENT_WORKING_DIR?.trim();
  if (configured) {
    return configured;
  }

  const workspacePref = configService?.getSettings().workspace;
  if (workspacePref) {
    const target = workspacePref.defaultOpenTarget ?? 'lastDirectory';
    if (target === 'fixedDirectory') {
      const pinned = resolveDirIfUsable(workspacePref.pinnedDirectory);
      if (pinned) return pinned;
    } else if (target === 'lastDirectory') {
      const recent = workspacePref.recentDirectories?.find((d) => resolveDirIfUsable(d));
      if (recent) return recent;
      const fallback = resolveDirIfUsable(workspacePref.defaultDirectory);
      if (fallback) return fallback;
    }
    // 'askEachTime' or unresolved → fall through
  }

  const cwd = process.cwd();
  const cwdRoot = cwd ? path.parse(cwd).root : '';

  if (app.isPackaged || !cwd || cwd === cwdRoot) {
    return app.getPath('home');
  }

  return cwd;
}

/**
 * Initialize cloud config, skills discovery, MCP, and codex detection.
 * These are chained because skills and MCP depend on CloudConfig.
 */
async function initializeCloudAndMCP(configService: ConfigService, mainWindow: AppWindow | null): Promise<void> {
  await initCloudConfigService({
    getAccessToken: () => getAuthService().getAccessToken(),
    // 把控制面下发的团队共享 provider / 服务 key reconcile 进本地配置（web/main 路径都要接）。
    onSharedProvidersResolved: (providers) => configService.reconcileManagedProviders(providers),
    onSharedServiceKeysResolved: (keys) => configService.reconcileManagedServiceApiKeys(keys),
    onSharedProviderKeysResolved: (keys) => configService.reconcileManagedProviderApiKeys(keys),
  });

  // 共享 provider 是 auth-gated：启动时的拉取还没登录拿不到，登录后必须重拉一次，否则共享模型要等
  // 缓存过期/重启才下发。仅在「未登录→登录」跃迁时刷新，避免刷新风暴。
  {
    let lastAuthed = false;
    getAuthService().addAuthChangeCallback((user) => {
      const authed = Boolean(user);
      if (authed && !lastAuthed) {
        void getCloudConfigService().refresh().catch((error) => {
          logger.warn('Cloud config refresh on login failed', { error: String(error) });
        });
      }
      lastAuthed = authed;
    });
  }

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
    const workingDir = getDesktopBootstrapWorkingDirectory(configService);
    const skillDiscovery = getSkillDiscoveryService();
    await skillDiscovery.initialize(workingDir);
    const stats = skillDiscovery.getStats();
    logger.info('SkillDiscovery initialized', {
      total: stats.total,
      builtin: stats.bySource.builtin,
      user: stats.bySource.user,
      project: stats.bySource.project,
      library: stats.bySource.library,
    });

    // Initialize SkillWatcher for hot-reload
    initSkillWatcher(workingDir)
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

  // 监听 config.json 外部编辑并热重载(API Key/模型路由/权限/并发/代理 现读即生效,无需重启)
  try {
    configService.startWatchingConfigFile(() => {
      logger.info('Settings hot-reloaded from external config.json edit');
    });
  } catch (cfgWatchError) {
    logger.warn('Config file watcher failed (non-blocking)', { error: String(cfgWatchError) });
  }

  const settings = configService.getSettings();
  const mcpConfigs: MCPServerConfig[] = settings.mcp?.servers || [];

  // Now initialize MCP client AFTER CloudConfig is ready
  logger.info('Initializing MCP servers...', { customCount: mcpConfigs.length });
  await initMCPClient(mcpConfigs, getDesktopBootstrapWorkingDirectory(configService));

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

  // MCP server 通过 listChanged 通知动态增删能力时，转发给 renderer 刷新 UI
  mcpClient.removeAllListeners('capabilities-changed');
  mcpClient.on('capabilities-changed', (payload: { serverName: string; kind: string; count: number }) => {
    logger.info('MCP capabilities changed', payload);
    getMainWindow()?.webContents.send(EVENT_CHANNELS.MCP, {
      type: 'capabilities_changed',
      data: [{ server: payload.serverName }],
    });
  });
}

/**
 * Initialize Supabase-dependent services: auth and sync
 */
function initializeSupabaseServices(mainWindow: AppWindow | null): void {
  if (!isSupabaseInitialized()) {
    logger.info('Supabase not configured (offline mode)');
    return;
  }

  logger.info('Supabase initialized');

  // Set up auth change callback
  const authService = getAuthService();
  authService.addAuthChangeCallback((user, status) => {
    if (mainWindow) {
      mainWindow.webContents.send(EVENT_CHANNELS.AUTH, {
        type: user ? 'signed_in' : 'signed_out',
        user,
        sessionTrustState: status.sessionTrustState,
        authBackendAvailable: status.authBackendAvailable,
        hasCachedAdminClaim: status.hasCachedAdminClaim,
        sessionExpired: status.sessionExpired,
      });
    }

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

    // Fleet telemetry 回传：登录起、登出停（auth-gated，内部默认 metadata-only）
    const telemetryUploader = getTelemetryUploaderService();
    if (user) {
      telemetryUploader.startAutoUpload();
      logger.info('Telemetry upload started');
    } else {
      telemetryUploader.stopAutoUpload();
      logger.info('Telemetry upload stopped');
    }

    // PostHog distinct_id：登录用稳定匿名 ID，登出清空（事件回退匿名）
    if (user) {
      const distinctId = getPostHogDistinctId(user.id);
      setCurrentDistinctId(distinctId);
      identifyNode(distinctId);
    } else {
      setCurrentDistinctId(null);
    }
  });

  // Initialize auth (restore session) - NON-BLOCKING
  authService.initialize()
    .then(() => logger.info('Auth service initialized'))
    .catch((error) => logger.error('Failed to initialize auth (non-blocking)', error));
}

/**
 * Setup LogBridge command handler for browser service integration
 */
async function setupLogBridge(): Promise<void> {
  logBridge.setCommandHandler(async (command, params) => {
    logger.debug('LogBridge command received', { command, paramKeys: Object.keys(params) });

    // The localhost log bridge has no durable Run/Agent owner or permission
    // channel. Browser reads and writes must therefore fail closed here and go
    // through ToolExecutor + SurfaceExecution instead of the legacy singleton.
    if (command === 'browser_action') {
      return {
        success: false,
        error: 'REMOTE_BROWSER_ACTION_REQUIRES_SURFACE_OWNER: use the authenticated ToolExecutor browser_action path.',
      };
    }

    switch (command) {
      case 'ping':
        return { success: true, output: 'pong' };

      default:
        return { success: false, error: `Unknown command: ${command}` };
    }
  });

  // P3-A：注册只读任务状态提供者（swarm/project/session 查询，仅元数据）。
  // 用 lazy getter，容忍 DB 尚未初始化——按请求取，取不到 repo 时安全降级（空/null）。
  logBridge.setTaskStatusProvider(
    new TaskStatusProvider({
      getSwarmRepo: () => {
        try {
          return getDatabase().getSwarmTraceRepo();
        } catch {
          return null;
        }
      },
      getProjectService: () => getProjectService(),
      getTaskManager: () => getTaskManager(),
    }),
  );

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

  // 预算告警广播：跨入 warning/blocked 时推一次到 renderer toast（每周期每级别一次，
  // 去重在 budgetService 内）。emit 时再取窗口，避免捕获 stale 引用。
  try {
    const { getBudgetService, BudgetAlertLevel } = await import('../services/core/budgetService');
    const { IPC_CHANNELS } = await import('../../shared/ipc');
    getBudgetService().setAlertListener((status) => {
      getMainWindow()?.webContents.send(IPC_CHANNELS.BUDGET_ALERT, {
        level: status.alertLevel === BudgetAlertLevel.BLOCKED ? 'blocked' : 'warning',
        currentCost: status.currentCost,
        maxBudget: status.maxBudget,
        usagePercentage: status.usagePercentage,
        message: status.message,
      });
    });
  } catch (error) {
    logger.warn('Failed to register budget alert listener', { error: String(error) });
  }

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

  try {
    const { config } = initSupabaseFromSettings(settings);
    logger.info('Supabase initialized (background)', {
      urlSource: config.urlSource,
      anonKeySource: config.anonKeySource,
    });
  } catch (error) {
    logger.warn('Supabase initialization failed (will retry on auth action)', { error: String(error) });
  }

  // CloudConfig → Skills → MCP (chained, non-blocking)
  initializeCloudAndMCP(configService, mainWindow)
    .catch((error) => logger.error('CloudConfig/MCP initialization failed', { error: String(error) }));

  // Initialize PromptService ASYNC (non-blocking, independent)
  initPromptService({
    getAccessToken: () => getAuthService().getAccessToken(),
  })
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

  // 注入 DAGScheduler 的 Agent 任务解析器（ADR-008 Phase 4 消除循环依赖）
  // scheduler 层不再直接 import agentDefinition，agent 配置通过 resolver 注入
  try {
    getDAGScheduler().setAgentResolver({
      resolve(role: string) {
        const cfg = getPredefinedAgent(role);
        if (!cfg) return undefined;
        return {
          systemPrompt: getAgentPrompt(cfg),
          tools: getAgentTools(cfg),
          maxIterations: getAgentMaxIterations(cfg),
        };
      },
    });
    logger.info('DAGScheduler agent resolver installed');
  } catch (error) {
    logger.warn('DAGScheduler agent resolver installation failed (non-blocking)', { error: String(error) });
  }

  // Initialize Cron Service
  initCronService()
    .then(() => {
      const stats = getCronService().getStats();
      logger.info('CronService initialized', { jobs: stats.totalJobs, active: stats.activeJobs });
    })
    .catch((error) => logger.warn('CronService initialization failed (non-blocking)', { error: String(error) }));

  // Register the built-in Light Memory consolidation job (idempotent by tag).
  // Ships in dry-run by default (MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT): it logs the
  // plan it would apply without writing, until the dry-run output is verified.
  initCronService()
    .then(async () => {
      const cron = getCronService();
      const existing = cron.listJobs({ tags: [MEMORY_CONSOLIDATION.JOB_TAG] });
      if (existing.length > 0) return;
      await cron.createJob({
        name: '[Maintenance] Light Memory consolidation',
        description: 'Compress ~/.code-agent/memory without losing information (quick model).',
        scheduleType: 'cron',
        schedule: { type: 'cron', expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION },
        action: { type: 'memory-consolidation', dryRun: MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT },
        enabled: true,
        tags: [MEMORY_CONSOLIDATION.JOB_TAG],
      });
      logger.info('Light Memory consolidation job registered', {
        expression: MEMORY_CONSOLIDATION.CRON_EXPRESSION,
        dryRun: MEMORY_CONSOLIDATION.DRY_RUN_DEFAULT,
      });
    })
    .catch((error) => logger.warn('Light Memory consolidation job registration failed (non-blocking)', { error: String(error) }));

  // Register the built-in Dream memory consolidation job (idempotent by tag).
  initCronService()
    .then(async () => {
      const { syncDreamCronJob, DREAM_CRON_JOB_TAG } = await import('../services/memory/dreamScheduler');
      const workingDirectory = getDesktopBootstrapWorkingDirectory(configService);
      const result = await syncDreamCronJob(getCronService(), { workingDirectory });
      logger.info('Dream memory consolidation job synced', {
        tag: DREAM_CRON_JOB_TAG,
        created: result.created,
      });
    })
    .catch((error) => logger.warn('Dream memory consolidation job registration failed (non-blocking)', { error: String(error) }));

  // Dream（roadmap 3.1）：注册 /dream 的 service 层 executor（executor 桥），
  // 让 /dream 走确定性 runDreamMemoryConsolidation（FTS 防幻觉门生效）。
  import('../services/memory/dreamExecutor')
    .then(({ registerDreamSkillExecutor }) => registerDreamSkillExecutor())
    .catch((error) => logger.warn('Dream skill executor registration failed (non-blocking)', { error: String(error) }));
  // Distill（roadmap 3.2）：注册 /distill 的 service 层 executor（executor 桥）
  // + 每 30 天自动 distill cron job（幂等 by tag，下方 initCronService）。
  import('../services/skills/distillExecutor')
    .then(({ registerDistillSkillExecutor }) => registerDistillSkillExecutor())
    .catch((error) => logger.warn('Distill skill executor registration failed (non-blocking)', { error: String(error) }));
  initCronService()
    .then(async () => {
      const { syncDistillCronJob, DISTILL_CRON_JOB_TAG } = await import('../services/skills/distillScheduler');
      const workingDirectory = getDesktopBootstrapWorkingDirectory(configService);
      const result = await syncDistillCronJob(getCronService(), { workingDirectory });
      logger.info('Distill workflow packaging job synced', {
        tag: DISTILL_CRON_JOB_TAG,
        created: result.created,
      });
    })
    .catch((error) => logger.warn('Distill workflow packaging job registration failed (non-blocking)', { error: String(error) }));

  // 角色主动性：按主动性配置同步 cadence cron job（幂等，每个持久化角色一个 job）
  // 内部文档 §2.1
  initCronService()
    .then(async () => {
      const { syncCadenceJobs } = await import('../services/roleAssets/roleProactivity');
      const synced = await syncCadenceJobs();
      logger.info('Role cadence jobs synced', synced);
    })
    .catch((error) => logger.warn('Role cadence jobs sync failed (non-blocking)', { error: String(error) }));

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
      const workingDir = getDesktopBootstrapWorkingDirectory(configService);
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

  // 清理过期 turn snapshots（启动时执行一次，按用户配置的保留天数）
  try {
    const { getDatabase } = await import('../services/core/databaseService');
    const db = getDatabase();
    if (db?.isReady) {
      const retentionDays = db.getPreference<number>('debugSnapshotRetentionDays', 1) ?? 1;
      // -1 = 永久保留，跳过清理
      if (retentionDays > 0) {
        const olderThanMs = retentionDays * 24 * 60 * 60 * 1000;
        const turnCleared = db.clearSnapshots({ olderThanMs });
        const compactCleared = db.clearCompactionSnapshots({ olderThanMs });
        if (turnCleared + compactCleared > 0) {
          logger.info('Cleaned up expired debug snapshots', { turnCleared, compactCleared, retentionDays });
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to cleanup turn snapshots', { error: err });
  }

  // Setup LogBridge command handler
  await setupLogBridge();

  // Supabase-dependent services
  initializeSupabaseServices(mainWindow);

  // Langfuse (可观测性) — 默认开启
  // key 解析优先级:用户自配(SecureStorage) > env 下发的项目默认 key(LANGFUSE_PUBLIC_KEY
  // /LANGFUSE_SECRET_KEY,由 getServiceApiKey 兜底) > settings。只要 key 可用就初始化,
  // 从而覆盖所有用户而非只覆盖手动配 key 的人。用户可通过 settings.langfuse.enabled=false
  // 显式关闭(opt-out,改后需重启生效)。
  const langfuseOptedOut = settings.langfuse?.enabled === false;
  const langfusePublicKey = configService.getServiceApiKey('langfuse_public') || settings.langfuse?.publicKey;
  const langfuseSecretKey = configService.getServiceApiKey('langfuse_secret') || settings.langfuse?.secretKey;
  if (langfuseOptedOut) {
    logger.info('Langfuse skipped: user opted out (settings.langfuse.enabled=false)');
  } else if (langfusePublicKey && langfuseSecretKey) {
    initLangfuse({
      publicKey: langfusePublicKey,
      secretKey: langfuseSecretKey,
      baseUrl: process.env.LANGFUSE_BASE_URL || settings.langfuse?.baseUrl || 'https://cloud.langfuse.com',
      enabled: true,
    });
    logger.info('Langfuse initialized');
  } else {
    logger.info('Langfuse skipped: no keys available (provision LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY env to enable by default)');
  }

  // Update service
  ensureUpdateServiceInitialized(configService, mainWindow
    ? (event) => mainWindow.webContents.send(EVENT_CHANNELS.UPDATE, event)
    : undefined);

  // Load soul/profile personality
  try {
    const workingDir = getDesktopBootstrapWorkingDirectory(configService);
    loadSoul(workingDir);
    watchSoulFiles(workingDir);
    logger.info('Soul/Profile loader initialized');
  } catch (error) {
    logger.warn('Soul/Profile loader failed (using default identity)', { error: String(error) });
  }

  // Initialize Agent Registry (custom agents from .code-agent/agents/*.md)
  // 预设角色（研究员/数据分析师）先安装再扫描，registry 才能解析到它们的 agent 定义
  try {
    const { installBuiltinRoles } = await import('../services/roleAssets');
    await installBuiltinRoles();
    const workingDir = getDesktopBootstrapWorkingDirectory(configService);
    await initAgentRegistry(workingDir);
    logger.info('Agent registry initialized');
  } catch (error) {
    logger.warn('Agent registry initialization failed (non-blocking)', { error: String(error) });
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
