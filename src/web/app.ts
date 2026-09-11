import { CompanionLibraryService } from '../host/services/companion/CompanionLibraryService';
import { CompanionFileService } from '../host/services/companion/CompanionFileService';
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
import { TraceReadService } from '../host/app/traceReadService';
import type { WebRouteLogger } from './routes/routeTypes';
import type { BuildInfo, PermissionRequest } from '../shared/contract';
import type { ConversationEnvelope } from '../shared/contract/conversationEnvelope';

import { formatError } from './helpers/utils';
import { handleTempUpload, handleScreenshot } from './helpers/upload';
import { dbAvailable, getPersistenceHealth } from './helpers/sessionCache';

// Middleware
import {
  SERVER_AUTH_TOKEN,
  authMiddleware,
  corsMiddleware,
  isWebServiceMode,
  rateLimitMiddleware,
} from './middleware/auth';

// Route modules
import { createHealthRouter } from './routes/health';
import { isDurableRunGateOpen } from './routes/agentDurableRouteLifecycle';
import { createSettingsRouter } from './routes/settings';
import { createExtractRouter } from './routes/extract';
import { createDomainRouter } from './routes/domain';
import { createShellRouter } from './routes/shell';
import { createStaticRouter } from './routes/static';
import { createInternalFeaturesRouter } from './routes/internalFeatures';
import type { InternalFeatureHostRuntime } from '../host/internalFeatures/internalFeatureHostRuntime';
import type { PluginRegistry } from '../host/plugins/pluginRegistry';
import { resolveRendererServeDecision } from '../host/services/renderer/rendererBundleCache';
import { createAgentRouter } from './routes/agent';
import type { PendingLocalToolCall } from './routes/agent';
import type { SupabaseAgentBinding } from './routes/agentRouteTypes';
import { createSessionsRouter } from './routes/sessions';
import type { SupabaseSessionBinding } from './routes/sessions';
import { createDevRouter } from './routes/dev';
import type { PendingDevPermissionRequest } from './routes/dev';
import { createBackgroundRouter } from './routes/background';
import { dispatchHostWebRoute } from '../host/services/capabilities/hostCapabilityContributions';
import { getRegisteredSpeechTranscriber } from '../host/services/capabilities/hostCapabilityPorts';
import { createAdminReviewQueueRouter } from './routes/adminReviewQueue';
import { createCompanionRouter } from './routes/companion';
import { createCompanionProvisioningRouter } from './routes/companionProvisioning';
import { CompanionGateway } from '../host/services/companion/CompanionGateway';
import { projectCompanionEvent } from '../host/services/companion/projectCompanionEvent';
import { CompanionApprovalService } from '../host/services/companion/CompanionApprovalService';
import type { PermissionResponse } from '../shared/contract/permission';
import { LanCompanionManager } from '../host/services/companion/LanCompanionManager';
import { IdleSleepInhibitor } from '../host/services/desktop/idleSleepInhibitor';
import { loadLanIdentity } from '../host/services/companion/lanIdentity';
import { COMPANION_MANAGE_CHANNEL } from '../shared/constants/companion';
import { getDatabase } from '../host/services/core/databaseService';
import type { AgentRunBody } from './routes/agentBodySchemas';
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
  /** 当前安装包的构建指纹；开发态和正式生产包为 null。 */
  getBuildInfo: () => BuildInfo | null;
  getDurableRunRollout: () => { policy: DurableRunRolloutPolicy; ready: boolean };
  getDurableRunReadService: () => DurableRunReadService | undefined;
  internalFeatures: {
    runtime: Pick<InternalFeatureHostRuntime, 'isLoaded' | 'loadedHash'>;
    registry: Pick<PluginRegistry, 'getPlugin'>;
    pluginsDir: string;
  };
  getPendingPermissionRequests?: () => PermissionRequest[];
  registerQueuedInputStartupSweep?: (runStartupSweep: () => void) => void;
  deliverCompanionPermission?: (requestId: string, response: PermissionResponse, sessionId: string) => { success: boolean; data?: { closed?: boolean } };
  registerCompanionShutdown?: (stop: () => Promise<void>) => void;
  registerQueuedInputEnqueueHook?: (onEnqueued: (sessionId: string) => void) => void;
  registerQueuedInputSendNowHook?: (sendNow: (input: {
    id: string;
    sessionId: string;
    envelope: ConversationEnvelope;
  }, route: 'active' | 'idle') => Promise<'sent' | 'steered' | 'queued'>) => void;
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
    getBuildInfo,
    getDurableRunRollout,
    getDurableRunReadService,
    getPendingPermissionRequests,
    internalFeatures,
  } = deps;

  const app = express();
  const traceReadService = new TraceReadService(resolveCodeAgentDataDir());
  let hasCompanionApprovalUi = (_sessionId: string, _request: PermissionRequest): boolean => false;
  let companionRun: ((body: AgentRunBody) => Promise<{ runId: string }>) | undefined;
  let publishCompanionEvent: ((sessionId: string, kind: string, payload: Record<string, unknown>) => void) | undefined;

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
    getBuildInfo,
    getPersistenceHealth,
    getDurableRunReady: () => isDurableRunGateOpen(getDurableRunRollout()),
    getRendererServeDecision: () => resolveRendererServeDecision(
      resolveCodeAgentDataDir(),
      path.resolve(__dirname, '..', 'renderer'),
      process.env,
      { currentShellVersion: getAppVersion() },
    ),
    getPendingPermissionRequests,
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
  app.get('/api/screenshot', async (req: Request, res: Response) => {
    const sessionManager = await tryGetSessionManager();
    let sessionWorkingDirectories: string[] = [];
    if (sessionManager) {
      try {
        const sessions = await sessionManager.listSessions({ limit: 500, includeArchived: true });
        sessionWorkingDirectories = sessions
          .map((session) => session.workingDirectory?.trim())
          .filter((workingDirectory): workingDirectory is string => Boolean(workingDirectory));
      } catch (error) {
        logger.warn('Failed to resolve session-bound screenshot roots', error);
      }
    }
    handleScreenshot(req, res, { sessionWorkingDirectories });
  });

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
    registerQueuedInputEnqueueHook: deps.registerQueuedInputEnqueueHook,
    registerQueuedInputSendNowHook: deps.registerQueuedInputSendNowHook,
    hasCompanionApprovalUi: (sessionId, request) => hasCompanionApprovalUi(sessionId, request),
    registerCompanionRun: (run) => { companionRun = run; },
    publishCompanionEvent: (sessionId, kind, payload) => publishCompanionEvent?.(sessionId, kind, payload),
  }));

  // 保活必须在数据库条件之外创建：runRegistry 不依赖 DB，数据库降级时运行中的长任务
  // 仍要阻止空闲休眠；companion 配对源在 db 分支里接线，无 gateway 时安全归 false。
  let inhibitorGateway: CompanionGateway | undefined;
  // registerCompanionShutdown 只保存一个回调（webServer.ts 的 stopCompanion 单槽），
  // 必须注册一次组合回调；companion 侧句柄在 db 分支里接线，未接线时安全跳过。
  let companionLan: { stop(): Promise<void> } | undefined;
  const idleSleepInhibitor = new IdleSleepInhibitor(
    () => runRegistry.size > 0,
    () => (inhibitorGateway?.pairedDevices().length ?? 0) > 0,
    { logger },
  );
  idleSleepInhibitor.start();
  deps.registerCompanionShutdown?.(async () => { await idleSleepInhibitor.stop(); await companionLan?.stop(); });

  try {
    const db = getDatabase().getDb();
    if (db) {
      let approvals: CompanionApprovalService | undefined;
      // gateway 与 library 互相依赖：gateway 的回调要调 library，library 又要拿 gateway。
      // 用一个 const 容器打破这个环，而不是先声明后赋值的 let——后者读起来像「可能被改」，
      // 实际只赋值一次，而且回调里读到的是同一个坑位。
      const services: { library?: CompanionLibraryService; files?: CompanionFileService } = {};
      const requireLibrary = () => {
        const library = services.library;
        // 回调只在路由挂载之后才可能触发，那时 library 早已就位；真取不到就说明接线断了。
        if (!library) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
        return library;
      };
      const gateway = new CompanionGateway(db, {
        sessionProject: id => requireLibrary().sessionProject(id),
        read: (deviceId, request) => {
          if (request.kind !== 'artifacts') return requireLibrary().read(deviceId, request);
          if (!services.files) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
          return Promise.resolve(services.files.list(request.sessionId));
        },
        refreshDecisions: () => approvals?.refresh(),
        decide: command => approvals?.respond(command) ?? { kind: 'rejected', reason: 'unsupported_action' },
        dispatch: (command) => {
          if (command.action.startsWith('files.')) {
            return services.files?.dispatch(command) ?? { state: 'rejected', result: { code: 'HOST_UNAVAILABLE' } };
          }
          if (command.action === 'voice.transcribe') {
            // Registered by the voice-input capability. Absent = that capability is not
            // installed, so say so now rather than parking the phone on 'reconciling'.
            const transcribe = getRegisteredSpeechTranscriber();
            if (!transcribe) return { state: 'rejected', result: { code: 'COMPANION_TRANSCRIPTION_UNAVAILABLE' } };
            void transcribe({ ...command.payload, mode: 'cloud-only', source: 'composer', keepAudioOnFailure: false, durationSeconds: command.payload.durationMs / 1000 })
              .then(result => gateway.settleCommand(command.deviceId, command.commandId, result.success && result.engine === 'groq' ? 'accepted' : 'rejected',
                result.success && result.engine === 'groq' ? { text: result.text, engine: result.engine } : { code: 'COMPANION_TRANSCRIPTION_FAILED' }),
                () => gateway.settleCommand(command.deviceId, command.commandId, 'rejected', { code: 'COMPANION_TRANSCRIPTION_FAILED' }));
            return { state: 'reconciling', result: { code: 'COMMAND_RECONCILING' } };
          }
          if (command.action.startsWith('session.')) {
            void requireLibrary().mutate(command).then(result => gateway.settleCommand(command.deviceId, command.commandId, 'accepted', result),
              error => gateway.settleCommand(command.deviceId, command.commandId, 'rejected', { code: error instanceof Error && error.message.startsWith('COMPANION_') ? error.message : 'COMPANION_OPERATION_FAILED' }));
            return { state: 'reconciling', result: { code: 'COMMAND_RECONCILING' } };
          }
          if (command.action === 'run.cancel' && command.sessionId) {
            const target = runRegistry.resolve({ sessionId: command.sessionId });
            if (!target) return { state: 'resolved', result: { alreadyTerminal: true } };
            if (target.context.runId !== command.payload.runId) return { state: 'rejected', result: { code: 'RUN_NOT_ACTIVE' } };
            void target.cancel('user');
            return { state: 'accepted', result: { stopping: true, runId: target.context.runId } };
          }
          if (command.action !== 'message.send' || !companionRun) return { state: 'rejected', result: { code: 'HOST_UNAVAILABLE' } };
          const payload = command.payload as { text?: unknown };
          const text = typeof payload.text === 'string' ? payload.text : '';
          const activation = companionRun({
            version: 1,
            prompt: text,
            sessionId: command.sessionId ?? undefined,
            clientMessageId: command.commandId,
          });
          void activation.then(({ runId }) => {
            gateway.settleCommand(command.deviceId, command.commandId, 'accepted', { runId });
          }, () => {
            gateway.settleCommand(command.deviceId, command.commandId, 'rejected', { code: 'RUN_START_FAILED' });
          }).catch(() => logger.warn('Companion activation receipt unavailable'));
          return { state: 'reconciling', result: { code: 'RUN_STARTING' } };
        },
      });
      services.library = new CompanionLibraryService(gateway, id => !!runRegistry.resolve({ sessionId: id }));
      services.files = new CompanionFileService(db, gateway, id => requireLibrary().workspaceOf(id));
      void services.library.cleanup().catch((error) => {
        logger.warn('Companion deleted-session cleanup unavailable', error);
      });
      if (getPendingPermissionRequests && deps.deliverCompanionPermission) {
        approvals = new CompanionApprovalService(gateway, getPendingPermissionRequests, deps.deliverCompanionPermission);
      }
      publishCompanionEvent = (sessionId, kind, payload) => {
        // 成果复制只对「有已配对手机」的桌面发生：没配对过的用户每次成图都复制一份
        // 进项目目录且无任何清理路径，是纯浪费（claude 复审 Important 2）。
        // pairedDevices() 是 SQL JOIN，只在真的涉及成果的两个 kind 里才算（流式事件每帧都过这里）。
        const raw = payload.event && typeof payload.event === 'object' && !Array.isArray(payload.event)
          ? payload.event as Record<string, unknown> : null;
        if (kind === 'artifact_write_started' && raw && gateway.pairedDevices().length > 0) {
          services.files?.noteWrite(sessionId, String(raw.toolCallId ?? ''), String(raw.filePath ?? ''));
        }
        const projection = projectCompanionEvent(kind, payload.event);
        if (!projection) {
          // 投影被丢弃的 tool_call_end 失败帧也要清掉 pendingWrites 记账，否则条目永久滞留。
          if (kind === 'tool_call_end' && raw && typeof raw.toolCallId === 'string' && raw.success !== true) {
            services.files?.discardWrite(sessionId, raw.toolCallId);
          }
          return;
        }
        try {
          gateway.publish(sessionId, kind, { ...projection, ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}) });
          if (kind === 'tool_call_end' && raw && typeof raw.toolCallId === 'string') {
            if (raw.success === true && gateway.pairedDevices().length > 0) {
              const artifact = services.files?.completeWrite(sessionId, raw.toolCallId);
              if (artifact) gateway.publish(sessionId, 'artifact', { ...artifact, ...(typeof payload.runId === 'string' ? { runId: payload.runId } : {}) });
            } else {
              services.files?.discardWrite(sessionId, raw.toolCallId);
            }
          }
        } catch {
          // A companion projection failure must not abort the desktop engine.
          logger.warn('Companion event projection unavailable');
        }
      };
      app.use('/api/companion', createCompanionProvisioningRouter({ gateway }));
      inhibitorGateway = gateway;
      const lan = new LanCompanionManager(gateway, () => loadLanIdentity(resolveCodeAgentDataDir()), async () => {
        const sessions = await (await tryGetSessionManager())?.listSessions() ?? [];
        return sessions.map(session => ({ id: session.id, title: session.title }));
      }, () => requireLibrary().projects());
      // Both halves must hold: a phone is reachable for this session, AND this particular
      // card is renderable. With no approvals service there is no companion approval path.
      hasCompanionApprovalUi = (sessionId, request) => lan.hasApprovalUi(sessionId) && approvals?.canDisplay(request) === true;
      handlers.set(COMPANION_MANAGE_CHANNEL, (_event, request) => lan.manage(request));
      // Web transport sends `companion:manage` to /api/companion/manage.
      // Keep an explicit route so browser/web builds can generate invitations
      // without relying on the generic IPC fallback (which is auth-gated).
      app.post('/api/companion/manage', async (req, res) => {
        try {
          const result = await lan.manage(req.body);
          res.json(result);
        } catch (error) {
          res.status(500).json({ success: false, error: { code: 'COMPANION_MANAGE_FAILED', message: error instanceof Error ? error.message : String(error) } });
        }
      });
      companionLan = lan;
      void lan.restore().catch(() => logger.warn('Companion LAN restore unavailable'));
      app.use('/companion', createCompanionRouter({
        gateway,
        authenticate: (deviceId, credential) => gateway.authenticateDevice(deviceId, credential),
      }));
    }
  } catch (error) {
    // Companion is additive: a migration/runtime failure must not prevent the desktop app from serving.
    logger.warn('Companion routes unavailable:', error);
  }

  app.use('/api', createBackgroundRouter({ logger }));
  app.use('/api', dispatchHostWebRoute);
  app.use('/api', createAdminReviewQueueRouter({ logger }));

  // ── Session routes (extracted to routes/sessions.ts) ────────────────
  app.use('/api', createSessionsRouter({
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
    getDurableRunReadService: () => getDurableRunReadService(),
    getTraceReadService: () => traceReadService,
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
  app.use(createInternalFeaturesRouter(internalFeatures));

  // 传 dataDir → 运行时解析 serve 目录：云端 active bundle 健康则 serve 热更前端，
  // 否则回包内基线（builtinDir 由 static.ts 按 __dirname 解析）。
  app.use(createStaticRouter({
    serverAuthToken: isWebServiceMode() ? null : SERVER_AUTH_TOKEN,
    dataDir: resolveCodeAgentDataDir(),
    currentShellVersion: getAppVersion(),
  }));

  return app;
}
