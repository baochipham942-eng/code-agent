 
// ============================================================================
// Web Server - 独立 HTTP API 服务器（无 Electron 依赖）
// ============================================================================
//
// 使 renderer 可以在浏览器中运行，无需 Electron。
// 通过 mock ipcMain 来复用所有现有 IPC handler 逻辑。
//
// 启动方式:
//   node dist/web/webServer.cjs
//   或 dev 模式: npm run dev:web
//
// ============================================================================

// ⚠️ webEnvInit 必须是第一个 import — 设置 CODE_AGENT_CLI_MODE 防止 keytar SIGSEGV
import './webEnvInit';

// Platform 模块替代 electron mock
import { handlers, ipcHost as mockIpcMain, AppWindow, onRendererPush, setBrowserWindowInteractionProbe } from '../host/platform';

import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'child_process';
import { setupAllIpcHandlers, type IpcDependencies } from '../host/ipc';
import { createLogger } from '../host/services/infra/logger';
import { loadShellEnvironment } from '../host/services/infra/shellEnvironment';
import { initSentryNode } from '../host/observability/sentryNode';
import { initCrashMarker } from '../host/observability/crashMarker';
import { initPostHogNode } from '../host/observability/posthogNode';
import { IPC_CHANNELS } from '../shared/ipc';
import { resolveSessionDefaultModelConfig } from '../host/services/core/sessionDefaults';
import { getModelSessionState } from '../host/session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../host/session/modelOverridePersistence';
import type { AuthUser, ModelProvider, PermissionResponse, Session } from '../shared/contract';
import type { SwarmTraceRepo } from '../shared/contract/swarmTrace';
import type { PendingApprovalRepository } from '../host/services/core/repositories/PendingApprovalRepository';
import { installLocalWebAuthStatusHandler } from './webLocalAuth';
import {
  initializeWebPluginSystem as initializeWebPluginSystemCore,
  startWebCapabilityBootstrap as startWebCapabilityBootstrapCore,
  type ConfigServiceForBootstrap,
  type WebCapabilityBootstrapOptions,
} from './webCapabilityBootstrap';

const logger = createLogger('WebServer');

// ── Boot timing instrumentation ─────────────────────────────────────
// 结构化启动分段耗时。每段边界打点，listen 时输出一张 delta 表，用于对账
// 「体感慢的大头在页外」这一诊断（对应 renderer 的 boot:* mark）。
// 关：CODE_AGENT_BOOT_TIMING=0。
const bootMarks: Array<{ label: string; t: number }> = [];
function bootMark(label: string): void {
  if (process.env.CODE_AGENT_BOOT_TIMING === '0') return;
  bootMarks.push({ label, t: performance.now() });
}
function dumpBootTiming(): void {
  if (bootMarks.length < 2) return;
  const t0 = bootMarks[0].t;
  const segments = bootMarks.map((m, i) => ({
    seg: m.label,
    at_ms: +(m.t - t0).toFixed(1),
    delta_ms: i === 0 ? 0 : +(m.t - bootMarks[i - 1].t).toFixed(1),
  }));
  logger.info('[boot-timing] webServer startup segments', {
    total_ms: +(bootMarks[bootMarks.length - 1].t - t0).toFixed(1),
    segments,
  });
}

// 崩溃上报尽早初始化（无 SENTRY_DSN 时为 no-op）
initSentryNode();
// 脏标记检测上次会话是否异常退出
initCrashMarker();
// PostHog 产品行为埋点（无 POSTHOG_KEY 时 no-op）
initPostHogNode();

export {
  getLocalWebAuthStatus,
  installLocalWebAuthStatusHandler,
  shouldUseLocalWebAuthStatus,
} from './webLocalAuth';

export type {
  ConfigServiceForBootstrap,
  WebCapabilityBootstrapOptions,
} from './webCapabilityBootstrap';

type SessionDomainPayload = {
  sessionId?: string;
  provider?: ModelProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  adaptive?: boolean;
  includeArchived?: boolean;
  title?: string;
  workingDirectory?: string;
  userMessageId?: string;
  updates?: Partial<Session>;
};

type SessionDomainIpcRequest = {
  action: string;
  payload?: SessionDomainPayload;
};

type SkillReloadStats = {
  total: number;
};

type PermissionResponseHandler = (
  event: unknown,
  requestId: string,
  response: PermissionResponse,
  sessionId?: string,
) => unknown | Promise<unknown>;

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

function resolveCodeAgentDataDir(): string {
  const configured = process.env.CODE_AGENT_DATA_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.code-agent');
}

function uniquePathList(paths: string[]): string[] {
  return [...new Set(paths)];
}

function getWebBootstrapWorkingDirectory(configService?: ConfigServiceForBootstrap): string {
  const configured = process.env.CODE_AGENT_WORKING_DIR?.trim();
  if (configured) return configured;

  const workspacePref = configService?.getSettings().workspace;
  if (workspacePref) {
    const target = workspacePref.defaultOpenTarget ?? 'lastDirectory';
    if (target === 'fixedDirectory') {
      const pinned = resolveDirIfUsable(workspacePref.pinnedDirectory);
      if (pinned) return pinned;
    } else if (target === 'lastDirectory') {
      for (const dir of workspacePref.recentDirectories || []) {
        const recent = resolveDirIfUsable(dir);
        if (recent) return recent;
      }
      const fallback = resolveDirIfUsable(workspacePref.defaultDirectory);
      if (fallback) return fallback;
    }
  }

  const cwd = process.cwd();
  const cwdRoot = cwd ? path.parse(cwd).root : '';
  if (!cwd || cwd === cwdRoot || cwd.includes('/Contents/Resources/')) {
    return os.homedir();
  }
  return cwd;
}

async function initializeWebSkillServices(configService: ConfigServiceForBootstrap): Promise<void> {
  try {
    const { initCloudConfigService, getCloudConfigService } = await import('../host/services/cloud');
    const { getAuthService } = await import('../host/services/auth/authService');
    const { getConfigService } = await import('../host/services/core/configService');
    await initCloudConfigService({
      // 发行版跑的就是本 webServer 路径：必须带上 access token，capability 门控的共享 provider 才会被下发。
      getAccessToken: () => getAuthService().getAccessToken(),
      // 把控制面下发的团队共享 provider / 服务 key reconcile 进本地配置（web/main 路径都要接，否则发行版不生效）。
      onSharedProvidersResolved: (providers) => getConfigService().reconcileManagedProviders(providers),
      onSharedServiceKeysResolved: (keys) => getConfigService().reconcileManagedServiceApiKeys(keys),
      onSharedProviderKeysResolved: (keys) => getConfigService().reconcileManagedProviderApiKeys(keys),
    });
    const info = getCloudConfigService().getInfo();
    logger.info('CloudConfig initialized', {
      source: info.fromCloud ? 'cloud' : 'builtin',
      version: info.version,
    });
  } catch (error) {
    logger.warn('CloudConfig initialization failed (non-blocking):', (error as Error).message);
  }

  const workingDir = getWebBootstrapWorkingDirectory(configService);

  try {
    const { getSkillRepositoryService, getSkillDiscoveryService, initSkillWatcher } = await import('../host/services/skills');
    const skillRepoService = getSkillRepositoryService();
    await skillRepoService.initialize();
    logger.info('SkillRepositoryService initialized', {
      libraryCount: skillRepoService.getLocalLibraries().length,
    });

    const skillDiscovery = getSkillDiscoveryService();
    await skillDiscovery.initialize(workingDir);
    const stats = skillDiscovery.getStats();
    logger.info('SkillDiscovery initialized', {
      workingDir,
      total: stats.total,
      builtin: stats.bySource.builtin,
      user: stats.bySource.user,
      project: stats.bySource.project,
      library: stats.bySource.library,
    });
    broadcastSSE('mcp:event', {
      type: 'server_connected',
      data: [{ server: 'skills', error: undefined }],
    });

    initSkillWatcher(workingDir)
      .then((watcher) => {
        watcher.on('reloaded', (reloadStats: SkillReloadStats) => {
          logger.info('Skills hot-reloaded', { total: reloadStats.total });
          broadcastSSE('mcp:event', {
            type: 'server_connected',
            data: [{ server: 'skills', error: undefined }],
          });
        });
        logger.info('SkillWatcher initialized', { watchCount: watcher.getWatchCount() });
      })
      .catch((watchError) => {
        logger.warn('SkillWatcher initialization failed (non-blocking):', (watchError as Error).message);
      });

    skillRepoService.preloadRecommendedRepositories()
      .then(async () => {
        await skillDiscovery.refreshLibraries();
        logger.info('Recommended skill repositories preloaded');
      })
      .catch((preloadError) => logger.warn('Failed to preload recommended repositories', { error: String(preloadError) }));
  } catch (error) {
    logger.warn('Skill services initialization failed (non-blocking):', (error as Error).message);
  }
}

async function initializeWebMcpServices(configService: ConfigServiceForBootstrap): Promise<void> {
  if (webMcpInitialized) return;
  const workingDir = getWebBootstrapWorkingDirectory(configService);

  try {
    const { initMCPClient, getMCPClient } = await import('../host/mcp/mcpClient');
    const mcpConfigs = configService.getSettings().mcp?.servers || [];

    logger.info('Initializing MCP servers...', {
      customCount: mcpConfigs.length,
      workingDir,
    });

    await initMCPClient(mcpConfigs, workingDir);

    const mcpClient = getMCPClient();
    const status = mcpClient.getStatus();
    const serverStates = mcpClient.getServerStates();
    const errorServers = serverStates.filter((server) => server.status === 'error');

    logger.info('MCP initialized', {
      total: serverStates.length,
      connected: status.connectedServers.join(', ') || 'none',
      inProcess: status.inProcessServers.join(', ') || 'none',
      toolCount: status.toolCount,
      errors: errorServers.map((server) => `${server.config.name}: ${server.error}`).join('; ') || 'none',
    });
    broadcastSSE('mcp:event', {
      type: 'capabilities_changed',
      data: [{ server: 'mcp' }],
    });

    if (errorServers.length > 0) {
      broadcastSSE('mcp:event', {
        type: 'connection_errors',
        data: errorServers.map((server) => ({ server: server.config.name, error: server.error })),
      });
    }

    mcpClient.removeAllListeners('capabilities-changed');
    mcpClient.on('capabilities-changed', (payload: { serverName: string; kind: string; count: number }) => {
      logger.info('MCP capabilities changed', payload);
      broadcastSSE('mcp:event', {
        type: 'capabilities_changed',
        data: [{ server: payload.serverName }],
      });
    });
    webMcpInitialized = true;
  } catch (error) {
    logger.warn('MCP initialization failed (non-blocking):', (error as Error).message);
  }
}

export async function initializeWebPluginSystem(): Promise<void> {
  await initializeWebPluginSystemCore({ logger, broadcastSSE });
}

export function startWebCapabilityBootstrap(
  configService: ConfigServiceForBootstrap,
  options: WebCapabilityBootstrapOptions = {},
): Promise<void> {
  return startWebCapabilityBootstrapCore(configService, {
    initializeSkills: initializeWebSkillServices,
    initializeMcp: initializeWebMcpServices,
    initializePlugins: initializeWebPluginSystem,
    logger,
    ...options,
  });
}

// ============================================================================
// SSE 客户端管理 & 会话缓存（从 helpers/ 导入）
// ============================================================================

import { broadcastSSE, sseClients } from './helpers/sse';
import {
  dbAvailable,
  setDbAvailable,
} from './helpers/sessionCache';
import { cleanupUploadDirs, ensureUploadRootDir } from './helpers/upload';

// Middleware
import {
  SERVER_AUTH_TOKEN,
  writeDevAuthToken,
} from './middleware/auth';

import { applyRendererBundleUpdate } from '../host/services/renderer/rendererBundleFetcher';
import { getAppVersion } from '../host/platform';
import { WEB_SERVER_DEFAULTS } from '../shared/constants/webServer';
import type { PendingLocalToolCall } from './routes/agent';
import { getApplicationRunRegistry } from '../host/app/applicationRunRegistry';
import { createApplicationAutoAgentRecoveryHost } from '../host/app/autoAgentRecoveryHost';
import { createApplicationNativeRecoveryPorts } from '../host/app/nativeRecoveryHost';
import {
  initializeDurableRun,
  type DurableRunApplicationRuntime,
} from '../host/app/initializeDurableRun';
import { resolveDurableRunRollout } from '../host/app/durableRunRollout';
import type { PendingDevPermissionRequest } from './routes/dev';
import { createApp } from './app';

// Re-export broadcastSSE for backward compatibility
export { broadcastSSE };

// Bridge: platform rendererBus → SSE clients
onRendererPush((channel, data) => {
  broadcastSSE(channel, data);
});

// Native run lifecycle ownership. Primary key is runId; sessionId is unique while active.
const runRegistry = getApplicationRunRegistry();
let durableRunRuntime: DurableRunApplicationRuntime | undefined;
let durableRunRolloutPolicy = resolveDurableRunRollout({});
let durableRunRolloutReady = false;
let webMcpInitialized = false;

// createApp() 的 durable run 状态注入：函数形式保证 app.ts 读到的始终是最新值
// （durableRunRolloutPolicy/Ready/durableRunRuntime 会在 initializeServices() 里异步更新）。
function getDurableRunRollout(): { policy: typeof durableRunRolloutPolicy; ready: boolean } {
  return { policy: durableRunRolloutPolicy, ready: durableRunRolloutReady };
}

function getDurableRunReadService() {
  return durableRunRuntime?.readService;
}

// ── Local Tool Bridge: 待处理的本地工具调用 ──
const pendingLocalToolCalls = new Map<string, PendingLocalToolCall>();
const pendingDevPermissions = new Map<string, PendingDevPermissionRequest>();

// ============================================================================
// 服务初始化
// ============================================================================

/**
 * 初始化后端服务（数据库、配置等）
 * 直接使用 main 服务（与 IPC handler 内部 import 一致）
 */
async function initializeServices(): Promise<void> {
  bootMark('init:start');
  // 设置环境
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_WEB_MODE = 'true';
  const initialDataDir = resolveCodeAgentDataDir();
  loadShellEnvironment({ dataDir: initialDataDir });

  // 加载 .env 文件（确保 API Key、HTTPS_PROXY 等环境变量可用）
  // 优先级：显式数据目录 .env → ~/.code-agent/.env（用户态，打包态主路径）→ 脚本所在目录 → 上级目录（开发态）
  // 不再搜 process.cwd()：launchd 启的 app cwd 是 /，永远 miss，且会让 dev/prod 行为发散
  let databaseForDurableRun: Awaited<ReturnType<(typeof import('../host/services/core/databaseService'))['initDatabase']>> | undefined;
  try {
    const dotenv = await import("dotenv");
    const candidates = uniquePathList([
      path.join(initialDataDir, ".env"),
      path.join(os.homedir(), ".code-agent", ".env"),
      path.join(__dirname, ".env"),
      path.join(__dirname, "..", ".env"),
    ]);
    for (const envPath of candidates) {
      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        logger.info(`.env loaded from ${envPath}`);
        break;
      }
    }
  } catch (e) {
    logger.warn(".env loading failed:", (e as Error).message);
  }

  // 设置数据目录（electronMock 的 app.getPath('userData') 也读这个变量）
  const dataDir = resolveCodeAgentDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  cleanupUploadDirs();
  ensureUploadRootDir();

  // 1. 初始化 ConfigService（main 模块的单例，IPC handler 通过 getConfigService() 获取）
  const { initConfigService } = await import('../host/services/core/configService');
  const configService = initConfigService();
  await configService.initialize().then(() => logger.info('ConfigService initialized'));
  bootMark('configService');

  // Initialize before exposing runtime preparation; SSE does not require mainWindow.
  (await import('../host/app/updateServiceBootstrap')).ensureUpdateServiceInitialized(configService, (event) => broadcastSSE('update:event', event));

  // 1b. 按用户设置 replay 原生连接器（默认全空）
  try {
    const { replayNativeConnectors } = await import('../host/connectors');
    const enabled = replayNativeConnectors(configService);
    logger.info('Native connectors configured', { enabled });
  } catch (error) {
    logger.warn('Native connectors replay failed:', (error as Error).message);
  }

  // 2. 初始化 Supabase（auth 等服务依赖）
  try {
    const { initSupabaseFromSettings } = await import('../host/services/infra/supabaseService');
    const settings = configService.getSettings();
    const { config } = initSupabaseFromSettings(settings);
    logger.info('Supabase initialized', {
      urlSource: config.urlSource,
      anonKeySource: config.anonKeySource,
    });
  } catch (error) {
    logger.warn('Supabase initialization failed (will retry on auth action):', (error as Error).message);
  }
  bootMark('supabase+connectors+update');

  // 3. 初始化 AuthService（依赖 Supabase，恢复登录态）
  // Playwright E2E 不验证真实登录态；跳过 AuthService 可隔离本机缓存用户和外部网络。
  if (process.env.CODE_AGENT_E2E === '1') {
    logger.info('AuthService skipped in E2E mode');
  } else {
    try {
      const { getAuthService } = await import('../host/services/auth/authService');
      const authService = getAuthService();
      // 注册 auth 变更广播：v0.16.79 修复管理员菜单不显示的根因。
      // Tauri 桌面那套 webContents.send 走 main/app/initBackgroundServices.ts，
      // web 模式（实际所有发行版都是 Tauri+webServer）根本没调那个 bootstrap，
      // 导致 fetchUserProfile 成功后没人推 SSE，renderer authStore isAdmin 永远 stale。
      authService.addAuthChangeCallback((user, status) => {
        broadcastSSE('auth:event', {
          type: user ? 'signed_in' : 'signed_out',
          user,
          sessionTrustState: status.sessionTrustState,
          authBackendAvailable: status.authBackendAvailable,
          hasCachedAdminClaim: status.hasCachedAdminClaim,
          sessionExpired: status.sessionExpired,
        });
      });
      await authService.initialize();
      logger.info('AuthService initialized');
    } catch (error) {
      logger.warn('AuthService not available:', (error as Error).message);
    }
  }
  bootMark('auth');

  // 4. 初始化 Database（main 模块的单例，SessionManager 等依赖）
  durableRunRolloutPolicy = resolveDurableRunRollout();
  durableRunRolloutReady = !durableRunRolloutPolicy.durableActivation;
  if (durableRunRolloutPolicy.diagnostic) logger.error(durableRunRolloutPolicy.diagnostic);
  try {
    const { initDatabase, onDatabaseRecovered } = await import('../host/services/core/databaseService');
    onDatabaseRecovered(() => {
      setDbAvailable(true);
    });
    databaseForDurableRun = await initDatabase();
    setDbAvailable(true);
    logger.info('Database initialized');
  } catch (error) {
    durableRunRolloutReady = false;
    setDbAvailable(false, error);
    if (error instanceof Error) {
      logger.warn('Database not available (using in-memory sessions):', error.message);
      logger.warn('Database init stack:', error.stack);
    } else {
      logger.warn('Database not available (using in-memory sessions):', String(error));
    }
  }
  bootMark('database');

  // 5. Fleet telemetry 回传：登录起、登出停（auth-gated，metadata-only）
  // 上传器此前只在 Electron main 路径（initBackgroundServices.ts）启动，而所有发行版实际跑的
  // 是本文件的 Tauri+webServer 路径 —— 没人启动它，这就是生产 trace 零回传的根因（2026-06-03 修复）。
  // 必须放在 Database init 之后：upload() 要读本地 telemetry 表，而 auth 恢复（步骤 3）早于 DB 就绪。
  if (process.env.CODE_AGENT_E2E === '1') {
    logger.info('Telemetry uploader skipped in E2E mode');
  } else {
    try {
      const { getAuthService } = await import('../host/services/auth/authService');
      const { getTelemetryUploaderService } = await import('../host/telemetry/telemetryUploaderService');
      const authService = getAuthService();
      const telemetryUploader = getTelemetryUploaderService();
      const syncTelemetryUploader = (user: AuthUser | null): void => {
        if (user) {
          telemetryUploader.startAutoUpload();
          logger.info('Telemetry upload started');
        } else {
          telemetryUploader.stopAutoUpload();
          logger.info('Telemetry upload stopped');
        }
      };
      // 步骤 3 的 auth 回调触发时 DB 还没就绪，这里按已恢复的登录态补启动
      syncTelemetryUploader(authService.getCurrentUser());
      // 后续登录/登出跟随切换
      authService.addAuthChangeCallback(syncTelemetryUploader);

      // 共享 provider（中转站）是 auth-gated：登录后重拉云端配置，触发 reconcile 下发共享模型。
      // 仅在「未登录→登录」跃迁刷新，避免刷新风暴。
      const { getCloudConfigService } = await import('../host/services/cloud');
      let lastAuthedCloud = Boolean(authService.getCurrentUser());
      authService.addAuthChangeCallback((user) => {
        const authed = Boolean(user);
        if (authed && !lastAuthedCloud) {
          void getCloudConfigService().refresh().catch((err) => {
            logger.warn('Cloud config refresh on login failed:', (err as Error).message);
          });
        }
        lastAuthedCloud = authed;
      });
    } catch (error) {
      logger.warn('Telemetry uploader not available:', (error as Error).message);
    }
  }

  // Memory service removed — Light Memory (file-based) is used instead
  bootMark('telemetry-wiring');

  // Skills and MCP are useful immediately after launch, but remote connections
  // must not sit in front of /api/health or Tauri's first window navigation.
  const capabilityBootstrap = startWebCapabilityBootstrap(configService);
  bootMark('capability-bootstrap-kickoff'); // 非阻塞：应≈0ms
  if (databaseForDurableRun) {
    void capabilityBootstrap.then(async () => {
      durableRunRuntime = await initializeDurableRun({
        registry: runRegistry,
        repository: durableRunRolloutPolicy.durableActivation
          ? databaseForDurableRun?.getDurableRunRepository() ?? null
          : null,
        dataDir,
        ownerId: 'web-native-host',
        processInstanceId: `web-${process.pid}-${randomUUID()}`,
        autoAgentRecoveryHost: createApplicationAutoAgentRecoveryHost(runRegistry),
        nativeRecoveryPorts: createApplicationNativeRecoveryPorts(),
        onDelayedResults: (results) => logger.info('Durable delayed recovery dispatched', { results }),
        onDelayedError: (recoveryError) => logger.error('Durable Run delayed recovery failed:', recoveryError),
      });
      durableRunRolloutReady = true;
      logger.info('Durable rollout initialized', {
        mode: durableRunRuntime.policy.mode,
        results: durableRunRuntime.recoveryResults,
      });
    }).catch((error) => {
      durableRunRolloutReady = false;
      logger.warn('Durable rollout initialization failed (non-blocking):', error instanceof Error ? error.message : String(error));
    });
  }

  // 启动时探测本地 CLI 能力（fire-and-forget，不阻塞初始化）
  // 探到的清单后续会注入 system prompt 的 <env-capabilities> 块
  void (async () => {
    try {
      const { probeEnvCapabilities } = await import('../host/services/core/envCapabilities');
      await probeEnvCapabilities();
    } catch (error) {
      logger.warn('EnvCapabilities probe failed (non-fatal):', (error as Error).message);
    }
  })();

  // 把 web 模式的 mock window 注入 contextHealthService，否则它的 emitHealthUpdate
  // 的 mainWindow 检查直接 return，前端 SSE 永远收不到 context fill 更新（实测：
  // 工具调用执行 39 turn 但 UI 占比纹丝不动）。
  try {
    const { getContextHealthService } = await import('../host/context/contextHealthService');
    getContextHealthService().setMainWindow(webModeWindow);
    logger.info('contextHealthService bound to web-mode window');
  } catch (error) {
    logger.warn('Failed to bind contextHealthService window:', (error as Error).message);
  }
  bootMark('probe+contextHealth');

  // 6. 预设角色安装 + Agent Registry 初始化。
  // Registry 此前只在 Electron main 路径（initBackgroundServices.ts）初始化，而所有发行版
  // 实际跑的是本文件的 Tauri+webServer 路径 —— 自定义 agent（~/.code-agent/agents/*.md）
  // 在发行版里从未被加载，spawn_agent 只能用 builtin 角色。持久化角色资产依赖自定义 agent
  // 解析，这里补上（与 fleet telemetry 同类的 web/main 路径分离修复）。
  try {
    const { installBuiltinRoles } = await import('../host/services/roleAssets');
    await installBuiltinRoles();
    const { initAgentRegistry } = await import('../host/agent/agentRegistry');
    await initAgentRegistry(undefined);
    // agents:changed 广播在 web 模式走不到（electronMock getAllWindows=[]），
    // 用 SSE 桥直接推给全部客户端，否则 renderer registry 停留在启动快照（S4）。
    const { bridgeAgentRegistryChangesToSSE } = await import('../host/agent/agentRegistrySSEBridge');
    bridgeAgentRegistryChangesToSSE(broadcastSSE);
    logger.info('Agent registry initialized (user-level agents + builtin roles)');
  } catch (error) {
    logger.warn('Agent registry init failed (non-blocking):', (error as Error).message);
  }
  bootMark('agent-registry');

  // 7. Cron 服务 + 角色主动性 cadence 同步。
  // 与步骤 6 同类的 web/main 路径分离修复：发行版跑的是 webServer，cron 调度器和
  // 角色 cadence job 必须在这里初始化，否则角色主动性在发行版里永远不会醒来。
  // 必须在 Agent Registry 之后（cadence 配置解析依赖 registry 的 frontmatter）。
  try {
    const { initCronService } = await import('../host/cron/cronService');
    await initCronService();
    const { syncCadenceJobs } = await import('../host/services/roleAssets/roleProactivity');
    const synced = await syncCadenceJobs();
    logger.info('Cron service initialized + role cadence jobs synced', synced);
  } catch (error) {
    logger.warn('Cron / role cadence init failed (non-blocking):', (error as Error).message);
  }
  bootMark('cron+cadence');

  // 8. Log Bridge + P3-A 只读任务状态 provider。
  // 与步骤 5/6/7 同类的 web/main 路径分离修复：logBridge.start() + provider 注册此前只在
  // Electron main 路径（initBackgroundServices.ts）执行，而所有发行版实际跑的是本 webServer
  // 路径 —— 不补这里，bridge 在发行版里从不启动，P3-A 只读工具（neo_list_tasks 等）以及现有
  // get_logs/get_status 的 bridge 拉取在发行版里全部失效。
  try {
    const { logBridge } = await import('../host/mcp/logBridge');
    const { TaskStatusProvider } = await import('../host/mcp/taskStatusProvider');
    const { getDatabase } = await import('../host/services/core/databaseService');
    const { getProjectService } = await import('../host/services/project/projectService');
    const { getTaskManager } = await import('../host/task/TaskManager');
    logBridge.setTaskStatusProvider(
      new TaskStatusProvider({
        getSwarmRepo: () => {
          try {
            const db = getDatabase();
            return db.isReady ? db.getSwarmTraceRepo() : null;
          } catch {
            return null;
          }
        },
        getProjectService: () => getProjectService(),
        getTaskManager: () => getTaskManager(),
      }),
    );
    await logBridge.start();
    logger.info('LogBridge started (web path) + P3-A task status provider registered');
  } catch (error) {
    logger.warn('LogBridge / task status provider init failed (non-blocking):', (error as Error).message);
  }
  bootMark('logbridge');

  // 9. 补 web 路径：初始化 TaskManager 单例（onAgentEvent/configService 注入）。
  // main 路径在 bootstrap → createAgentRuntime 里做，webServer 此前从未做 —— 又一处
  // web/main 路径分离：不补这里，loop / cron 的 agent action 调
  // getOrCreateCurrentOrchestrator 永远 unavailable（发行版跑的就是本 webServer 路径）。
  // createAgentRuntime 用 getMainWindow()（web 模式 = webModeWindow → SSE）转发 agent 事件。
  try {
    const { createAgentRuntime } = await import('../host/app/createAgentRuntime');
    createAgentRuntime(configService as unknown as Parameters<typeof createAgentRuntime>[0]);
    logger.info('TaskManager initialized (web path) via createAgentRuntime');
  } catch (error) {
    logger.warn('createAgentRuntime init failed (web, non-blocking):', (error as Error).message);
  }
  bootMark('agent-runtime');

  logger.info('Backend services initialized');
}

// ============================================================================
// IPC Handler 注册
// ============================================================================

/**
 * 注册所有 IPC handler 到 mock ipcMain
 */
// Web 模式的全局 BrowserWindow 实例（webContents.send → broadcastSSE）
const webModeWindow = new AppWindow();
setBrowserWindowInteractionProbe(() => sseClients.size > 0);

// 注册到 main/app/window.ts 的 module-level mainWindow，让所有调
// getMainWindow() 的后台服务（auth、update、mcp 等）能拿到 mock window
// 走 SSE 推送，否则 callback 里 `if (mainWindow)` 永远 false，事件黑洞。
// 用同步 require 保证 esbuild 把 window.ts 视为单例（避免 dynamic import 切分到独立 chunk）。
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setMainWindow } = require('../host/app/window') as typeof import('../host/app/window');
  setMainWindow(webModeWindow);
  logger.info('webModeWindow registered as mainWindow for SSE bridge');
} catch (err) {
  logger.warn('Failed to register webModeWindow as mainWindow:', err);
}

function registerHandlers(): void {
  let currentSessionId: string | null = null;

  // ADR-010: 注入 swarm 业务依赖到 SwarmServices 注册表（web 模式 wiring）
  // 此前只有 src/host/index.ts (Tauri 桌面入口) 调用过 registerSwarmServices，
  // web/e2e 路径下 swarm.ipc.ts 的 handler 触发时会抛 "SwarmServices not registered"
  // 被 try/catch 兜底返回空数据，导致 SwarmTraceHistory 等功能在 web 模式永远空。
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerSwarmServices } = require('../host/agent/swarmServices') as typeof import('../host/agent/swarmServices');
    const { getPlanApprovalGate } = require('../host/agent/planApproval') as typeof import('../host/agent/planApproval');
    const { getSwarmLaunchApprovalGate } = require('../host/agent/swarmLaunchApproval') as typeof import('../host/agent/swarmLaunchApproval');
    const { getParallelAgentCoordinatorRegistry } = require('../host/agent/parallelAgentCoordinator') as typeof import('../host/agent/parallelAgentCoordinator');
    const { getSpawnGuard } = require('../host/agent/spawnGuard') as typeof import('../host/agent/spawnGuard');
    const { getTeammateService } = require('../host/agent/teammate/teammateService') as typeof import('../host/agent/teammate/teammateService');
    const { persistAgentRun, getRecentAgentHistory } = require('../host/session/agentHistoryPersistence') as typeof import('../host/session/agentHistoryPersistence');
    const { installSwarmTraceWriter } = require('../host/agent/swarmTraceWriter') as typeof import('../host/agent/swarmTraceWriter');
    const { getDatabase } = require('../host/services/core/databaseService') as typeof import('../host/services/core/databaseService');
    /* eslint-enable @typescript-eslint/no-require-imports */

    let swarmTraceRepo: SwarmTraceRepo | null = null;
    let pendingApprovalRepo: PendingApprovalRepository | null = null;
    try {
      const db = getDatabase();
      if (db.isReady) {
        swarmTraceRepo = db.getSwarmTraceRepo();
        pendingApprovalRepo = db.getPendingApprovalRepo();
      }
    } catch (err) {
      logger.warn('Repositories not ready at web bootstrap:', (err as Error).message);
    }

    const planApprovalGate = getPlanApprovalGate();
    const launchApprovalGate = getSwarmLaunchApprovalGate();

    if (pendingApprovalRepo) {
      try {
        const planOrphans = planApprovalGate.attachPersistence(pendingApprovalRepo);
        const launchOrphans = launchApprovalGate.attachPersistence(pendingApprovalRepo);
        if (planOrphans + launchOrphans > 0) {
          logger.warn(
            `Orphaned approvals from previous web process: ${planOrphans} plan(s) + ${launchOrphans} launch(es)`,
          );
        }
      } catch (err) {
        logger.warn('PendingApproval hydration failed (web):', (err as Error).message);
      }
    }

    registerSwarmServices({
      planApproval: planApprovalGate,
      launchApproval: launchApprovalGate,
      parallelCoordinators: getParallelAgentCoordinatorRegistry(),
      spawnGuard: getSpawnGuard(),
      teammateService: getTeammateService(),
      agentHistory: { persistAgentRun, getRecentAgentHistory },
      swarmTraceRepo,
    });

    if (swarmTraceRepo) {
      try {
        installSwarmTraceWriter(swarmTraceRepo, {
          getSessionId: () => currentSessionId,
        });
      } catch (err) {
        logger.warn('SwarmTraceWriter install failed (web):', (err as Error).message);
      }
    }

    logger.info('SwarmServices registered for web mode');
  } catch (err) {
    logger.warn('SwarmServices registration failed (web):', (err as Error).message);
  }

  const deps: IpcDependencies = {
    getMainWindow: () => webModeWindow,
    getAppService: () => null, // Web mode uses HTTP API, not AppService
    getConfigService: () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getConfigService } = require('../host/services/core/configService') as typeof import('../host/services/core/configService');
        return getConfigService();
      } catch {
        return null;
      }
    },
    getPlanningService: () => null,
    getTaskManager: () => null,
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: (id: string) => {
      currentSessionId = id;
    },
  };

  // setupAllIpcHandlers 会同时处理:
  // 1. 接受 ipcMain 参数的 handler — 注册到我们传入的 mockIpcMain
  // 2. 直接 import { ipcMain } from 'electron' 的 handler — 注册到 electronMock 的 ipcMain
  // 由于 installElectronMock() 已将 'electron' 模块替换为 mock，两种方式最终都注册到同一个 handlers Map
  setupAllIpcHandlers(mockIpcMain, deps);

  if (installLocalWebAuthStatusHandler(handlers)) {
    logger.info('Local web auth status enabled for E2E/dev API mode');
  }

  const originalPermissionResponseHandler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE) as PermissionResponseHandler | undefined;
  handlers.set(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_event: unknown, requestId: string, response: PermissionResponse, sessionId?: string) => {
      const pending = pendingDevPermissions.get(requestId);
      if (pending) {
        pending.resolve(response);
        return {
          success: true,
          data: {
            requestId,
            sessionId: sessionId || pending.request.sessionId,
            source: 'web-dev-real-approval',
          },
        };
      }

      if (originalPermissionResponseHandler) {
        return originalPermissionResponseHandler(_event, requestId, response, sessionId);
      }

      return {
        success: false,
        error: {
          code: 'PENDING_PERMISSION_NOT_FOUND',
          message: `No pending permission request found for ${requestId}`,
        },
      };
    }
  );

  // Override domain:session handler — session.ipc.ts requires AppService which is null in web mode.
  // Re-route to SessionManager (same logic as the REST /api/sessions endpoints).
  handlers.set('domain:session', async (_event: unknown, request: SessionDomainIpcRequest) => {
    const { action, payload } = request;
    try {
      if (action === 'switchModel') {
        if (!payload?.sessionId || !payload?.provider || !payload?.model) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId, provider and model are required' } };
        }
        const override = {
          provider: payload.provider,
          model: payload.model,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          adaptive: payload.adaptive,
        };
        getModelSessionState().setOverride(payload.sessionId, override);
        // 落库让切换跨重启存活（生产 web 路径）；无 DB 时跳过，内存 override 本轮仍生效。
        // persisted 标志透出（audit R1-HIGH2：落库失败不静默谎报成功）
        const persisted = dbAvailable
          ? await persistModelOverride(payload.sessionId, override)
          : false;
        return {
          success: true,
          data: {
            provider: payload.provider,
            model: payload.model,
            adaptive: payload.adaptive,
            persisted,
          },
        };
      }

      if (action === 'getModelOverride') {
        if (!payload?.sessionId) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
        }
        let override = getModelSessionState().getOverride(payload.sessionId);
        // 重启后内存 Map 为空：按持久化标记回灌，保证 UI（ModelSwitcher）重开会话即显示切换值
        if (!override && dbAvailable) {
          try {
            const { getSessionManager } = await import('../host/services/infra/sessionManager');
            const session = await getSessionManager().getSession(payload.sessionId, 1);
            override = rehydrateModelOverrideFromSession(session);
          } catch { /* 会话不存在或 DB 异常：维持 null，UI 回落默认 */ }
        }
        return { success: true, data: override };
      }

      if (action === 'clearModelOverride') {
        if (!payload?.sessionId) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
        }
        getModelSessionState().clearOverride(payload.sessionId);
        const cleared = dbAvailable
          ? await clearPersistedModelOverride(payload.sessionId)
          : false;
        return { success: true, data: { persisted: cleared } };
      }

      let sm: Awaited<ReturnType<typeof import('../host/services/infra/sessionManager').getSessionManager>> | null = null;
      if (dbAvailable) {
        try {
          const { getSessionManager } = await import('../host/services/infra/sessionManager');
          sm = getSessionManager();
        } catch { /* DB not available */ }
      }
      if (!sm) {
        return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' } };
      }
      let data: unknown;
      switch (action) {
        case 'list':
          data = await sm.listSessions(payload as { includeArchived?: boolean } | undefined);
          break;
        case 'create':
          data = await sm.createSession({
            title: payload?.title || 'New Session',
            workingDirectory:
              typeof payload?.workingDirectory === 'string' && payload.workingDirectory.trim().length > 0
                ? payload.workingDirectory.trim()
                : undefined,
            modelConfig: resolveSessionDefaultModelConfig(),
          });
          sm.setCurrentSession((data as { id: string }).id);
          break;
        case 'load':
          data = await sm.restoreSession(payload?.sessionId as string);
          break;
        case 'delete':
          await sm.deleteSession(payload?.sessionId as string);
          data = null;
          break;
        case 'getMessages':
          data = await sm.getMessages(payload?.sessionId as string);
          break;
        case 'getSessionTasks': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' },
            };
          }
          const { listTasks } = await import('../host/services/planning/taskStore');
          data = listTasks(sessionId);
          break;
        }
        case 'rewindToPrompt': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          const userMessageId = typeof payload?.userMessageId === 'string' ? payload.userMessageId.trim() : '';
          if (!sessionId || !userMessageId) {
            return {
              success: false,
              error: {
                code: 'INVALID_PAYLOAD',
                message: 'sessionId and userMessageId are required',
              },
            };
          }
          if (runRegistry.hasSession(sessionId)) {
            throw new Error('Cannot rewind while the session is running');
          }

          const { getDatabase } = await import('../host/services/core/databaseService');
          const db = getDatabase();
          const anchorMessage = db.getMessageById(sessionId, userMessageId);
          if (anchorMessage?.role !== 'user') {
            throw new Error(`Active user message not found: ${userMessageId}`);
          }

          const { getFileCheckpointService } = await import('../host/services/checkpoint');
          const checkpointService = getFileCheckpointService();
          const checkpoint = await checkpointService.getFirstCheckpointAtOrAfter(
            sessionId,
            anchorMessage.timestamp,
          );

          let filesRestored = 0;
          let filesDeleted = 0;
          const errors: string[] = [];

          if (checkpoint) {
            const rewindFilesResult = await checkpointService.rewindFiles(sessionId, checkpoint.messageId);
            filesRestored = rewindFilesResult.restoredFiles.length;
            filesDeleted = rewindFilesResult.deletedFiles.length;
            if (!rewindFilesResult.success) {
              const message = rewindFilesResult.errors.map((item) => item.error).filter(Boolean).join('; ')
                || 'File checkpoint rewind failed';
              throw new Error(message);
            }
            errors.push(...rewindFilesResult.errors.map((item) => item.error).filter(Boolean));
          }

          const rewindResult = await sm.applyPromptRewind(sessionId, userMessageId, {
            checkpointMessageId: checkpoint?.messageId ?? null,
            filesRestored,
            filesDeleted,
            errors,
          });

          data = {
            success: true,
            sessionId,
            rewindId: rewindResult.rewindId,
            draft: {
              content: anchorMessage.content,
              attachments: anchorMessage.attachments,
            },
            activeMessages: rewindResult.activeMessages,
            hiddenMessageCount: rewindResult.hiddenMessageCount,
            filesRestored,
            filesDeleted,
          };
          break;
        }
        case 'export':
          data = await sm.exportSession(payload?.sessionId as string);
          break;
        case 'update':
          await sm.updateSession(payload?.sessionId as string, payload?.updates || {});
          data = null;
          break;
        case 'archive':
          data = await sm.archiveSession(payload?.sessionId as string);
          break;
        case 'unarchive':
          data = await sm.unarchiveSession(payload?.sessionId as string);
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown session action: ${action}` } };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
    }
  });

  logger.info(`Registered ${handlers.size} IPC handlers`);
}

// ============================================================================
// Port cleanup
// ============================================================================

/** Kill any process holding the target port (zombie node processes from previous runs) */
async function killPortHolder(port: number): Promise<void> {
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' }).trim();
    if (!pids) return;

    // Don't kill ourselves
    const myPid = process.pid.toString();
    const targetPids = pids.split('\n').filter((p) => p !== myPid && /^\d+$/.test(p));
    if (targetPids.length === 0) return;

    console.log(`  Killing zombie process(es) on port ${port}: PID ${targetPids.join(', ')}`);
    execFileSync('kill', ['-9', ...targetPids], { encoding: 'utf-8' });

    // Brief wait for OS to release the port
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch {
    // lsof returns exit code 1 when no match — port is free
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  bootMark('main:start');
  const port = parseInt(process.env.WEB_PORT || String(WEB_SERVER_DEFAULTS.PORT), 10);
  const host = process.env.WEB_HOST || WEB_SERVER_DEFAULTS.HOST;

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Agent Neo — Web Standalone Mode        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // 启动前先清理：用户强杀 Tauri 主进程后，旧 webServer 可能残留占住端口。
  // 这一步必须早于服务初始化，否则新壳进程 healthcheck 会先撞到旧 boot token。
  await killPortHolder(port);
  bootMark('killPortHolder');

  // 1. 初始化后端服务
  console.log('[1/3] Initializing backend services...');
  await initializeServices();

  // 2. 注册 IPC handler
  console.log('[2/3] Registering IPC handlers...');
  registerHandlers();
  bootMark('registerHandlers');

  // 3. 启动 HTTP 服务
  console.log('[3/3] Starting HTTP server...');

  const app = createApp({
    handlers,
    logger,
    runRegistry,
    pendingLocalToolCalls,
    pendingDevPermissions,
    resolveCodeAgentDataDir,
    getAppVersion,
    getDurableRunRollout,
    getDurableRunReadService,
  });

  const server = http.createServer(app);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ❌ Port ${port} is still in use after cleanup attempt.`);
      console.error(`     Run: lsof -ti:${port} | xargs kill -9`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    bootMark('listen');
    dumpBootTiming();
    // Write token to .dev-token for Vite dev server to read
    writeDevAuthToken(SERVER_AUTH_TOKEN);

    console.log();
    // Machine-readable startup JSON (Tauri main.rs parses this)
    console.log(JSON.stringify({ port, token: SERVER_AUTH_TOKEN }));
    console.log();
    console.log(`  API server:  http://${host}:${port}`);
    console.log(`  Health:      http://${host}:${port}/api/health`);
    console.log(`  SSE Events:  http://${host}:${port}/api/events`);
    console.log(`  Auth token:  ${SERVER_AUTH_TOKEN.slice(0, 8)}...`);
    console.log();
    console.log(`  Registered handlers: ${handlers.size}`);
    console.log(`  Channels: ${[...handlers.keys()].slice(0, 10).join(', ')}...`);
    console.log();
    console.log('  Start Vite dev server separately:');
    console.log('    npm run dev:renderer');
    console.log();
  });

  // 优雅退出
  const shutdown = async () => {
    console.log('\nShutting down...');
    // .dev-token 保留不删 — dev 下 kill/restart webServer 时 auth.ts 会复用
    // 同一个 token，避免 Tauri WebView 里固化的旧 token 失效踩 "Invalid auth
    // token"。若要轮换 token，手动删 .dev-token 后重启 webServer。
    cleanupUploadDirs();
    await durableRunRuntime?.shutdown().catch((error) => {
      console.warn('[shutdown] durable recovery runtime failed:', error);
    });
    // V2-A: 关掉所有用户起的 dev server，避免 Vite/CRA 子进程成孤儿
    try {
      const { getDevServerManager } = await import('../host/services/infra/devServerManager');
      await getDevServerManager().disposeAll();
    } catch (err) {
      console.warn('[shutdown] devServerManager dispose failed:', err);
    }
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ── 前端热更：启动后异步拉取（不阻塞 health，失败不影响启动）─────────
  // 后台拉取+验签+切换 active/；当前页面保持旧前端，刷新或重新打开后按新 active serve。
  // 兜底铁律全在 applyRendererBundleUpdate 内，任何失败都保持当前前端。
  if (process.env.CODE_AGENT_RENDERER_HOT_UPDATE !== 'false') {
    void applyRendererBundleUpdate({
      dataDir: resolveCodeAgentDataDir(),
      currentShellVersion: getAppVersion(),
      logger: (msg) => console.log(msg),
    }).catch((err) => {
      console.warn('[renderer-hot-update] background update error:', err);
    });
  }

  // Tauri 父进程死亡检测：父进程退出/崩溃（含 SIGABRT）时 stdin 管道关闭，
  // webServer 跟着优雅退出，不留孤儿进程占住端口。
  // 仅在被 Tauri spawn 时生效（standalone / dev 模式没有这个环境变量，不受影响）。
  if (process.env.CODE_AGENT_TAURI_BOOT_TOKEN) {
    process.stdin.resume();
    process.stdin.on('end', () => { void shutdown(); });
    process.stdin.on('error', () => { void shutdown(); });
  }
}

if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('Failed to start web server:', err);
    process.exit(1);
  });
}
