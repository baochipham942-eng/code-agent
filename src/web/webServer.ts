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

// electron mock 通过 esbuild --alias:electron=./src/web/electronMock.ts 注入
import { handlers, ipcMain as mockIpcMain, BrowserWindow } from './electronMock';

import http from 'http';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import express from 'express';
import type { Request, Response } from 'express';
import { setupAllIpcHandlers, type IpcDependencies } from '../main/ipc';
import { createLogger } from '../main/services/infra/logger';
import { IPC_CHANNELS } from '../shared/ipc';
import type { PermissionResponse } from '../shared/types';

const logger = createLogger('WebServer');

// ============================================================================
// SSE 客户端管理 & 会话缓存（从 helpers/ 导入）
// ============================================================================

import { broadcastSSE } from './helpers/sse';
import { formatError } from './helpers/utils';
import {
  dbAvailable,
  setDbAvailable,
} from './helpers/sessionCache';
import { handleTempUpload, handleScreenshot, cleanupUploadDirs, ensureUploadRootDir } from './helpers/upload';

// Middleware
import { SERVER_AUTH_TOKEN, corsMiddleware, rateLimitMiddleware, authMiddleware } from './middleware/auth';

// Route modules
import { createHealthRouter } from './routes/health';
import { createSettingsRouter } from './routes/settings';
import { createExtractRouter } from './routes/extract';
import { createDomainRouter } from './routes/domain';
import { createStaticRouter } from './routes/static';
import { createAgentRouter } from './routes/agent';
import type { PendingLocalToolCall } from './routes/agent';
import { createSessionsRouter } from './routes/sessions';
import { createDevRouter } from './routes/dev';
import type { PendingDevPermissionRequest } from './routes/dev';

// Re-export broadcastSSE so electronMock.ts `require('./webServer')` still works
export { broadcastSSE };

// 活跃 AgentLoop 实例追踪（用于 cancel）
const activeAgentLoops = new Map<string, { cancel(): void }>();

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
  // 设置环境
  process.env.CODE_AGENT_CLI_MODE = 'true';
  process.env.CODE_AGENT_WEB_MODE = 'true';

  // 加载 .env 文件（确保 API Key 等环境变量可用）
  try {
    const dotenv = await import("dotenv");
    // 按优先级搜索 .env：cwd → 脚本所在目录 → 资源目录（Tauri 打包）
    const candidates = [
      path.join(process.cwd(), ".env"),
      path.join(__dirname, ".env"),
      path.join(__dirname, "..", ".env"),
    ];
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
  const dataDir = path.join(os.homedir(), '.code-agent');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  process.env.CODE_AGENT_DATA_DIR = dataDir;
  cleanupUploadDirs();
  ensureUploadRootDir();

  // 1. 初始化 ConfigService（main 模块的单例，IPC handler 通过 getConfigService() 获取）
  const { initConfigService } = await import('../main/services/core/configService');
  const configService = initConfigService();
  await configService.initialize();
  logger.info('ConfigService initialized');

  // 2. 初始化 Supabase（auth 等服务依赖）
  try {
    const { initSupabase } = await import('../main/services/infra/supabaseService');
    const { DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_ANON_KEY } = await import('../shared/constants');
    const settings = configService.getSettings() as Record<string, any>;
    const supabaseUrl = process.env.SUPABASE_URL || settings.supabase?.url || DEFAULT_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || settings.supabase?.anonKey || DEFAULT_SUPABASE_ANON_KEY;
    initSupabase(supabaseUrl, supabaseAnonKey);
    logger.info('Supabase initialized');
  } catch (error) {
    logger.warn('Supabase not available:', (error as Error).message);
  }

  // 3. 初始化 AuthService（依赖 Supabase，恢复登录态）
  try {
    const { getAuthService } = await import('../main/services/auth/authService');
    await getAuthService().initialize();
    logger.info('AuthService initialized');
  } catch (error) {
    logger.warn('AuthService not available:', (error as Error).message);
  }

  // 4. 初始化 Database（main 模块的单例，SessionManager 等依赖）
  try {
    const { initDatabase } = await import('../main/services/core/databaseService');
    await initDatabase();
    setDbAvailable(true);
    logger.info('Database initialized');
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('Database not available (using in-memory sessions):', error.message);
      logger.warn('Database init stack:', error.stack);
    } else {
      logger.warn('Database not available (using in-memory sessions):', String(error));
    }
  }

  // 5. 初始化 MemoryService（session handler 的 handleCreate 会调用 getMemoryService）
  try {
    const { initMemoryService } = await import('../main/memory/memoryService');
    initMemoryService({
      maxRecentMessages: 10,
      toolCacheTTL: 5 * 60 * 1000,
      maxSessionMessages: 100,
      maxRAGResults: 5,
      ragTokenLimit: 2000,
    });
    logger.info('MemoryService initialized');
  } catch (error) {
    logger.warn('MemoryService not available:', (error as Error).message);
  }

  logger.info('Backend services initialized');
}

// ============================================================================
// IPC Handler 注册
// ============================================================================

/**
 * 注册所有 IPC handler 到 mock ipcMain
 */
// Web 模式的全局 BrowserWindow 实例（webContents.send → broadcastSSE）
const webModeWindow = new BrowserWindow();

function registerHandlers(): void {
  let currentSessionId: string | null = null;

  const deps: IpcDependencies = {
    getMainWindow: () => webModeWindow as any,
    getAppService: () => null, // Web mode uses HTTP API, not AppService
    getConfigService: () => {
      try {
        const { getConfigService } = require('../main/services/core/configService');
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
  setupAllIpcHandlers(mockIpcMain as any, deps);

  const originalPermissionResponseHandler = handlers.get(IPC_CHANNELS.AGENT_PERMISSION_RESPONSE);
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
        return originalPermissionResponseHandler(_event as never, requestId, response, sessionId);
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
  handlers.set('domain:session', async (_event: unknown, request: { action: string; payload?: any }) => {
    const { action, payload } = request;
    try {
      let sm: Awaited<ReturnType<typeof import('../main/services/infra/sessionManager').getSessionManager>> | null = null;
      if (dbAvailable) {
        try {
          const { getSessionManager } = await import('../main/services/infra/sessionManager');
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
            generationId: 'gen8',
            modelConfig: {
              provider: 'moonshot',
              model: 'kimi-k2.5',
              temperature: 0.7,
              maxTokens: 8192,
            },
          });
          break;
        case 'load':
          data = await sm.restoreSession(payload?.sessionId);
          break;
        case 'delete':
          await sm.deleteSession(payload?.sessionId);
          data = null;
          break;
        case 'getMessages':
          data = await sm.getMessages(payload?.sessionId);
          break;
        case 'export':
          data = await sm.exportSession(payload?.sessionId);
          break;
        case 'update':
          await sm.updateSession(payload?.sessionId, payload?.updates || {});
          data = null;
          break;
        case 'archive':
          data = await sm.archiveSession(payload?.sessionId);
          break;
        case 'unarchive':
          data = await sm.unarchiveSession(payload?.sessionId);
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
// Express 应用
// ============================================================================

function createApp(): express.Express {
  const app = express();

  // CORS — restrict to known origins
  app.use(corsMiddleware);

  // Rate limiting
  app.use('/api', rateLimitMiddleware);

  // Auth — Bearer token required for all /api/* except /api/health
  app.use('/api', authMiddleware);

  // JSON body parser
  app.use(express.json({ limit: '50mb', strict: false }));

  // ── Health & SSE (extracted to routes/health.ts) ────────────────────
  app.use('/api', createHealthRouter({ handlers }));

  // ── File upload ─────────────────────────────────────────────────────
  app.post('/api/upload/temp', async (req: Request, res: Response) => {
    try {
      await handleTempUpload(req, res);
    } catch (error) {
      logger.error('Temporary upload failed', error);
      const message = formatError(error);
      const status = message.includes('50MB limit')
        ? 413
        : (message === 'Missing file field' || message === 'Upload aborted' ? 400 : 500);
      res.status(status).json({ error: message });
    }
  });

  // ── Screenshot proxy ────────────────────────────────────────────────
  app.get('/api/screenshot', handleScreenshot);

  // ── Dev routes (workspace/file, dev/exec-tool, dev/smoke/office) ────
  app.use('/api', createDevRouter({ pendingDevPermissions, logger }));

  // ── Shared helpers for agent & session routes ──────────────────────

  /**
   * 获取 SessionManager（仅在 DB 可用时）
   */
  async function tryGetSessionManager() {
    if (!dbAvailable) return null;
    try {
      const { getSessionManager } = await import('../main/services/infra/sessionManager');
      return getSessionManager();
    } catch {
      return null;
    }
  }

  /**
   * 获取 Supabase client + user_id（用于 Web 模式云端持久化）
   */
  async function getSupabaseForSession(): Promise<{ supabase: any; userId: string } | null> {
    try {
      const { getSupabase, isSupabaseInitialized } = await import('../main/services/infra/supabaseService');
      if (!isSupabaseInitialized()) return null;
      const { getAuthService } = await import('../main/services/auth/authService');
      const user = getAuthService().getCurrentUser();
      if (!user?.id) return null;
      return { supabase: getSupabase(), userId: user.id };
    } catch {
      return null;
    }
  }

  // ── Agent routes (extracted to routes/agent.ts) ─────────────────────
  app.use('/api', createAgentRouter({
    activeAgentLoops,
    pendingLocalToolCalls,
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
  }));

  // ── Session routes (extracted to routes/sessions.ts) ────────────────
  app.use('/api', createSessionsRouter({
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
  }));

  // ── Settings (extracted to routes/settings.ts) ─────────────────────
  app.use('/api', createSettingsRouter({ handlers }));

  // ── Extract & Speech (extracted to routes/extract.ts) ───────────────
  app.use('/api', createExtractRouter({ handlers }));

  // ── Domain & Fallback (extracted to routes/domain.ts) ───────────────
  app.use('/api', createDomainRouter({ handlers, logger }));

  // ── Static & SPA (extracted to routes/static.ts) ───────────────────
  app.use(createStaticRouter({ serverAuthToken: SERVER_AUTH_TOKEN }));

  return app;
}

// ============================================================================
// Port cleanup
// ============================================================================

/** Kill any process holding the target port (zombie node processes from previous runs) */
async function killPortHolder(port: number): Promise<void> {
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (!pids) return;

    // Don't kill ourselves
    const myPid = process.pid.toString();
    const targetPids = pids.split('\n').filter((p) => p !== myPid);
    if (targetPids.length === 0) return;

    console.log(`  Killing zombie process(es) on port ${port}: PID ${targetPids.join(', ')}`);
    execSync(`kill -9 ${targetPids.join(' ')}`, { encoding: 'utf-8' });

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
  const port = parseInt(process.env.WEB_PORT || '8180', 10);
  const host = process.env.WEB_HOST || '127.0.0.1';

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   Code Agent — Web Standalone Mode       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // 1. 初始化后端服务
  console.log('[1/3] Initializing backend services...');
  await initializeServices();

  // 2. 注册 IPC handler
  console.log('[2/3] Registering IPC handlers...');
  registerHandlers();

  // 3. 启动 HTTP 服务
  console.log('[3/3] Starting HTTP server...');

  // 启动前清理：kill 占用目标端口的僵尸进程
  await killPortHolder(port);

  const app = createApp();

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
  const shutdown = () => {
    console.log('\nShutting down...');
    cleanupUploadDirs();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start web server:', err);
  process.exit(1);
});
