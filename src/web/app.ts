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
import { getRegisteredSpeechTranscriber, registerUserQuestionRoute } from '../host/services/capabilities/hostCapabilityPorts';
import { companionTranscriptionSettlement } from '../shared/contract/speech';
import { createAdminReviewQueueRouter } from './routes/adminReviewQueue';
import { createCompanionRouter } from './routes/companion';
import { createCompanionProvisioningRouter } from './routes/companionProvisioning';
import { CompanionGateway } from '../host/services/companion/CompanionGateway';
import { companionApnsOutboxTransport } from '../host/services/companion/companionApnsProvider';
import { CompanionPushOutbox, loadPushWrapKeySync } from '../host/services/companion/CompanionPushOutbox';
import { projectCompanionEvent } from '../host/services/companion/projectCompanionEvent';
import { CompanionApprovalService } from '../host/services/companion/CompanionApprovalService';
import { CompanionQuestionService } from '../host/services/companion/CompanionQuestionService';
import { CompanionPlanService } from '../host/services/companion/CompanionPlanService';
import { deliverCompanionUserPlan, listCompanionUserPlans, noteCompanionUserPlan } from '../host/services/companion/companionUserPlan';
import { getPlanApprovalGate } from '../host/agent/planApproval';
import type { PermissionResponse } from '../shared/contract/permission';
import { LanCompanionManager } from '../host/services/companion/LanCompanionManager';
import { startCompanionRelayAccountIfConfigured, startCompanionRelayIfConfigured } from '../host/services/companion/CompanionRelayClient';
import { loadCompanionRelayConfig } from '../host/services/companion/companionRelayConfig';
import { getAuthService } from '../host/services/auth/authService';
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
  let companionRelay: { stop(): Promise<void>; routeFor(deviceId: string): import('../shared/contract/companionRelay').CompanionRelayRoute | null; connected: boolean } | undefined;
  let companionRelayAbandoned = false;
  let companionRelayAccount: ReturnType<typeof startCompanionRelayAccountIfConfigured> | null = null;
  const idleSleepInhibitor = new IdleSleepInhibitor(
    () => runRegistry.size > 0,
    () => (inhibitorGateway?.pairedDevices().length ?? 0) > 0,
    { logger },
  );
  idleSleepInhibitor.start();
  let cleanupQuestionRoute: () => void = () => {};
  deps.registerCompanionShutdown?.(async () => {
    cleanupQuestionRoute();
    await idleSleepInhibitor.stop();
    companionRelayAbandoned = true;
    await companionRelayAccount?.stop();
    await companionRelay?.stop();
    await companionLan?.stop();
  });

  try {
    const db = getDatabase().getDb();
    if (db) {
      // gateway 与 library 互相依赖：gateway 的回调要调 library，library 又要拿 gateway。
      // 用一个 const 容器打破这个环，而不是先声明后赋值的 let——后者读起来像「可能被改」，
      // 实际只赋值一次，而且回调里读到的是同一个坑位。
      const services: {
        library?: CompanionLibraryService;
        files?: CompanionFileService;
        push?: CompanionPushOutbox;
        approvals?: CompanionApprovalService;
        questions?: CompanionQuestionService;
        plans?: CompanionPlanService;
        relay?: { revoke(deviceId: string): void };
      } = {};
      const requireLibrary = () => {
        const library = services.library;
        // 回调只在路由挂载之后才可能触发，那时 library 早已就位；真取不到就说明接线断了。
        if (!library) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
        return library;
      };
      const gateway = new CompanionGateway(db, {
        sessionProject: id => requireLibrary().sessionProject(id),
        sessionVisible: id => requireLibrary().sessionExists(id),
        read: (deviceId, request) => {
          if (request.kind !== 'artifacts') return requireLibrary().read(deviceId, request);
          if (!services.files) throw new Error('COMPANION_LIBRARY_UNAVAILABLE');
          return Promise.resolve(services.files.list(request.sessionId));
        },
        refreshDecisions: () => { services.approvals?.refresh(); services.questions?.refresh(); services.plans?.refresh(); },
        decide: command => {
          if (command.action === 'approval.respond') return services.approvals?.respond(command) ?? { kind: 'rejected', reason: 'unsupported_action' };
          if (command.action === 'question.respond') return services.questions?.respond(command) ?? { kind: 'rejected', reason: 'unsupported_action' };
          if (command.action === 'plan.respond') return services.plans?.respond(command) ?? { kind: 'rejected', reason: 'unsupported_action' };
          return { kind: 'rejected', reason: 'unsupported_action' };
        },
        onPublish: event => { services.push?.enqueue(event); void services.push?.flush(); },
        onRevoke: deviceId => { services.push?.forgetDevice(deviceId); services.relay?.revoke(deviceId); companionRelayAccount?.revoke(deviceId); },
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
              .then(result => {
                // 真实错误码要带回去：手机按它分「这段没人说话」与「真失败」。
                const settlement = companionTranscriptionSettlement(result);
                return gateway.settleCommand(command.deviceId, command.commandId, settlement.state, settlement.result);
              },
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
            if (!target) {
              // 恢复成 waiting 的 durable run 没有 handle（recoverDurable 只登记 owner + 心跳），
              // resolve() 查不到。先同步探测有没有这种 run，有就在规范路径上终态化并补发
              // agent_cancelled，再按 alreadyTerminal 结算——手机据此清 runId 收尾。
              const waiting = runRegistry.findRecoveredWaitingRun({
                sessionId: command.sessionId,
                runId: command.payload.runId,
              });
              if (waiting) {
                void runRegistry.terminalRecoveredWaitingRun({ runId: waiting.runId })
                  .then((recovered) => {
                    if (recovered && !recovered.joined) {
                      publishCompanionEvent?.(command.sessionId, 'agent_cancelled', { event: null, runId: recovered.runId });
                    }
                    gateway.settleCommand(command.deviceId, command.commandId, 'accepted', {
                      alreadyTerminal: true,
                      ...(recovered ? { runId: recovered.runId } : {}),
                    });
                  })
                  .catch((error) => {
                    logger.warn('Companion waiting-run cancel failed', error);
                    gateway.settleCommand(command.deviceId, command.commandId, 'rejected', { code: 'COMPANION_OPERATION_FAILED' });
                  });
                return { state: 'reconciling', result: { code: 'COMMAND_RECONCILING' } };
              }
              return { state: 'resolved', result: { alreadyTerminal: true } };
            }
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
      const apns = companionApnsOutboxTransport(process.env);
      services.push = new CompanionPushOutbox(db, gateway, {
        wrapKey: loadPushWrapKeySync(resolveCodeAgentDataDir()),
        apnsKeyPath: apns.apnsKeyPath,
        send: apns.send,
      });
      void services.library.cleanup().catch((error) => {
        logger.warn('Companion deleted-session cleanup unavailable', error);
      });
      if (getPendingPermissionRequests && deps.deliverCompanionPermission) {
        services.approvals = new CompanionApprovalService(gateway, getPendingPermissionRequests, deps.deliverCompanionPermission);
      }
      services.questions = new CompanionQuestionService(gateway);
      cleanupQuestionRoute = registerUserQuestionRoute(services.questions);
      services.plans = new CompanionPlanService(gateway, () => [
        ...getPlanApprovalGate().getPendingPlans().flatMap(plan => {
          const sessionId = plan.scope?.sessionId;
          if (!sessionId) return [];
          return [{ id: plan.id, sessionId, plan: plan.plan, agentName: plan.agentName, risk: plan.risk }];
        }),
        ...listCompanionUserPlans(),
      ], (planId, approved, feedback, sessionId) => {
        const gate = getPlanApprovalGate();
        const plan = gate.getPlan(planId);
        if (plan?.status === 'pending' && plan.scope?.sessionId === sessionId) {
          const ok = approved ? gate.approve(planId, feedback) : gate.reject(planId, feedback?.trim() || 'Rejected');
          return { success: ok };
        }
        return deliverCompanionUserPlan(planId, approved, feedback, sessionId, (id, prompt, options) => {
          if (!companionRun) return Promise.reject(new Error('HOST_UNAVAILABLE'));
          return companionRun({
            sessionId: id,
            prompt,
            ...(options?.historyVisibility ? { historyVisibility: options.historyVisibility } : {}),
            ...(options?.disableAutoAgent ? { disableAutoAgent: true } : {}),
          });
        });
      });
      publishCompanionEvent = (sessionId, kind, payload) => {
        const raw = payload.event && typeof payload.event === 'object' && !Array.isArray(payload.event)
          ? payload.event as Record<string, unknown> : null;
        const notedUserPlan = kind === 'tool_call_end' && raw ? noteCompanionUserPlan(sessionId, raw) : false;
        if (!gateway.hasLiveDevices()) return;
        // 成果复制只对「有已配对手机」的桌面发生：没配对过的用户每次成图都复制一份
        // 进项目目录且无任何清理路径，是纯浪费（claude 复审 Important 2）。
        // pairedDevices() 是 SQL JOIN，只在真的涉及成果的两个 kind 里才算（流式事件每帧都过这里）。
        if (kind === 'artifact_write_started' && raw && gateway.pairedDevices().length > 0) {
          services.files?.noteWrite(sessionId, String(raw.toolCallId ?? ''), String(raw.filePath ?? ''));
        }
        if (notedUserPlan) services.plans?.refresh();
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
      }, () => requireLibrary().projects(), services.push,
      // relay 客户端是异步拨起的：手机问路由时它可能还没就绪——闭包读当前值，null 即 unavailable。
      deviceId => companionRelay?.routeFor(deviceId) ?? null,
      // 跨网连接状态块（N-COMPANION-RELAY-ACCOUNT-DESKTOP-STATUS）：照 relayRoute 的方式注入取值回调。
      // configured 每次现读配置文件（状态请求只在打开设置页时发生，频率极低）；缺省日志已由两条通道启动时打过。
      () => ({
        configured: !!loadCompanionRelayConfig(resolveCodeAgentDataDir()),
        legacy: companionRelay?.connected ? 'connected' as const : 'disconnected' as const,
        // 句柄还没赋上（db 分支未接线/启动瞬间）时按没开通报：那种场景下整个 manage 口都不存在。
        ...(companionRelayAccount?.status() ?? { account: 'off' as const }),
      }));
      // Both halves must hold: a phone is reachable for this session, AND this particular
      // card is renderable. With no approvals service there is no companion approval path.
      hasCompanionApprovalUi = (sessionId, request) => lan.hasApprovalUi(sessionId) && services.approvals?.canDisplay(request) === true;
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
      void startCompanionRelayIfConfigured({
        dataDirectory: resolveCodeAgentDataDir(),
        gateway,
        loadIdentity: () => loadLanIdentity(resolveCodeAgentDataDir()),
        logger,
      }).then(client => {
        if (!client) return;
        if (companionRelayAbandoned) {
          void client.stop();
          return;
        }
        services.relay = client;
        companionRelay = client;
      }).catch((error) => logger.warn(
        'Companion relay dial-out skipped',
        error instanceof Error ? error.message : String(error),
      ));
      // 账号通道与上面的共享凭据通道并行（N-COMPANION-RELAY-ACCOUNT-BIND）：没登录就什么都不做。
      companionRelayAccount = startCompanionRelayAccountIfConfigured({
        dataDirectory: resolveCodeAgentDataDir(),
        gateway,
        loadIdentity: () => loadLanIdentity(resolveCodeAgentDataDir()),
        auth: getAuthService(),
        logger,
      });
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
