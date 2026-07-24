// ============================================================================
// Web App Assembly - 纯 Express app 装配（无顶层副作用）
// ============================================================================
//
// 从 webServer.ts 抽出：middleware 挂载顺序 + 路由注册，逐字节保持原有顺序/行为。
// 本模块不做任何 import 期副作用（不碰 webEnvInit / host/platform / observability），
// 所有运行态依赖通过 CreateAppDeps 参数注入，便于装配测试对照真实 middleware 顺序/路由表。
//
// ============================================================================

import path from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../host/platform';
import type { RunRegistry } from '../host/runtime/runRegistry';
import type { DurableRunRolloutPolicy } from '../host/app/durableRunRollout';
import type { DurableRunReadService } from '../host/app/durableRunReadService';
import type { WebRouteLogger } from './routes/routeTypes';

import { formatError } from './helpers/utils';
import { handleTempUpload, handleScreenshot } from './helpers/upload';
import { dbAvailable, getPersistenceHealth } from './helpers/sessionCache';

// Middleware
import {
  SERVER_AUTH_TOKEN,
  authMiddleware,
  corsMiddleware,
  rateLimitMiddleware,
} from './middleware/auth';

// Route modules
import { createHealthRouter } from './routes/health';
import { createSettingsRouter } from './routes/settings';
import { createExtractRouter } from './routes/extract';
import { createDomainRouter } from './routes/domain';
import { createShellRouter } from './routes/shell';
import { createStaticRouter } from './routes/static';
import { resolveRendererServeDecision } from '../host/services/renderer/rendererBundleCache';
import { createAgentRouter } from './routes/agent';
import type { PendingLocalToolCall } from './routes/agent';
import type { SupabaseAgentBinding } from './routes/agentRouteTypes';
import { createSessionsRouter } from './routes/sessions';
import type { SupabaseSessionBinding } from './routes/sessions';
import { createDevRouter } from './routes/dev';
import type { PendingDevPermissionRequest } from './routes/dev';
import { createBackgroundRouter } from './routes/background';
import { createAdminReviewQueueRouter } from './routes/adminReviewQueue';
import { wireGenerativeUiEditProjectionInvalidation } from './helpers/generativeUiEditWiring';

type WebSupabaseBinding = SupabaseAgentBinding & SupabaseSessionBinding;

export interface CreateAppDeps {
  /** IPC handler 注册表（host/platform 的 handlers Map，由调用方注入以避免本模块 import 该桶）。 */
  handlers: Map<string, HandlerFn>;
  logger: WebRouteLogger;
  /** Native run lifecycle registry（webServer.ts 单例，注入以保证同一实例）。 */
  runRegistry: RunRegistry;
  pendingLocalToolCalls: Map<string, PendingLocalToolCall>;
  pendingDevPermissions: Map<string, PendingDevPermissionRequest>;
  /** 数据目录解析（纯函数，每次调用重新求值，与原实现一致）。 */
  resolveCodeAgentDataDir: () => string;
  /** 当前 shell 版本（来自 host/platform，注入以避免本模块 import 该桶）。 */
  getAppVersion: () => string;
  getDurableRunRollout: () => { policy: DurableRunRolloutPolicy; ready: boolean };
  getDurableRunReadService: () => DurableRunReadService | undefined;
  registerQueuedInputStartupSweep?: (runStartupSweep: () => void) => void;
}

/**
 * 获取 SessionManager（仅在 DB 可用时）
 */
async function tryGetSessionManager() {
  if (!dbAvailable) return null;
  try {
    const { getSessionManager } = await import('../host/services/infra/sessionManager');
    return getSessionManager();
  } catch {
    return null;
  }
}

/**
 * 获取 Supabase client + user_id（用于 Web 模式云端持久化）
 */
async function getSupabaseForSession(): Promise<WebSupabaseBinding | null> {
  try {
    const { getSupabase, isSupabaseInitialized } = await import('../host/services/infra/supabaseService');
    if (!isSupabaseInitialized()) return null;
    const { getAuthService } = await import('../host/services/auth/authService');
    const user = getAuthService().getCurrentUser();
    if (!user?.id) return null;
    return {
      supabase: getSupabase() as unknown as WebSupabaseBinding['supabase'],
      userId: user.id,
    };
  } catch {
    return null;
  }
}

export function createApp(deps: CreateAppDeps): express.Express {
  const {
    handlers,
    logger,
    runRegistry,
    pendingLocalToolCalls,
    pendingDevPermissions,
    resolveCodeAgentDataDir,
    getAppVersion,
    getDurableRunRollout,
    getDurableRunReadService,
  } = deps;

  const app = express();

  // HTML 产物人工编辑落库后让 web 消息投影失效（dogfood 抓到的崩法 A 根因）
  wireGenerativeUiEditProjectionInvalidation();

  // CORS — restrict to known origins
  app.use(corsMiddleware);

  // Rate limiting
  app.use('/api', rateLimitMiddleware);

  // Auth — Bearer token required for all /api/* except /api/health
  app.use('/api', authMiddleware);

  // JSON body parser
  app.use(express.json({ limit: '50mb', strict: false }));

  // ── Health & SSE (extracted to routes/health.ts) ────────────────────
  app.use('/api', createHealthRouter({
    handlers,
    getPersistenceHealth,
    getRendererServeDecision: () => resolveRendererServeDecision(
      resolveCodeAgentDataDir(),
      path.resolve(__dirname, '..', 'renderer'),
      process.env,
      { currentShellVersion: getAppVersion() },
    ),
  }));

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
  app.use('/api', createDevRouter({ pendingDevPermissions, runRegistry, logger }));

  // ── Agent routes (extracted to routes/agent.ts) ─────────────────────
  app.use('/api', createAgentRouter({
    runRegistry,
    pendingLocalToolCalls,
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
    getDurableRunRollout: () => getDurableRunRollout(),
    getDurableRunReadService: () => getDurableRunReadService(),
    registerQueuedInputStartupSweep: deps.registerQueuedInputStartupSweep,
  }));

  app.use('/api', createBackgroundRouter({ logger }));
  app.use('/api', createAdminReviewQueueRouter({ logger }));

  // ── Session routes (extracted to routes/sessions.ts) ────────────────
  app.use('/api', createSessionsRouter({
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
    getDurableRunReadService: () => getDurableRunReadService(),
  }));

  // ── Settings (extracted to routes/settings.ts) ─────────────────────
  app.use('/api', createSettingsRouter({ handlers }));

  // ── Extract & Speech (extracted to routes/extract.ts) ───────────────
  app.use('/api', createExtractRouter({ handlers }));

  // ── Domain & Fallback (extracted to routes/domain.ts) ───────────────
  app.use('/api', createDomainRouter({ handlers, logger }));

  // ── Shell capabilities (renderer hot-update ABI contract) ───────────
  app.use('/api', createShellRouter({ getAppVersion }));

  // ── Static & SPA (extracted to routes/static.ts) ───────────────────
  // 传 dataDir → 运行时解析 serve 目录：云端 active bundle 健康则 serve 热更前端，
  // 否则回包内基线（builtinDir 由 static.ts 按 __dirname 解析）。
  app.use(createStaticRouter({
    serverAuthToken: SERVER_AUTH_TOKEN,
    dataDir: resolveCodeAgentDataDir(),
    currentShellVersion: getAppVersion(),
  }));

  return app;
}
