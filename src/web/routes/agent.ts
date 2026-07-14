 
import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'node:crypto';
import type { MessageAttachment, MessageMetadata, Session, SessionStatus } from '../../shared/contract';
import type { ModelProvider } from '../../shared/contract/model';
import type {
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { AGENT_ENGINE_LABELS, normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import { broadcastSSE } from '../helpers/sse';
import { agentRunSseLimiter, extractRequestToken } from '../helpers/sseConnectionLimit';
import { formatError } from '../helpers/utils';
import {
  dbAvailable,
  type CachedMessage,
} from '../helpers/sessionCache';
import { createWebSessionStore } from '../helpers/webSessionStore';
import { buildGoalContract } from '../../host/agent/goalModeController';
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  KimiCliAdapter,
  MimoCliAdapter,
  getRemoteAgentEngineModelCatalogService,
  isExternalAgentEngine,
  resolveExternalEngineLaunch,
} from '../../host/services/agentEngine';
import {
  type ExternalAgentEngineFailureContext,
  recordExternalEngineFailure,
} from './agentEngineFailureRecorder';
import {
  AgentRunBodySchema,
  AgentToolResultBodySchema,
} from './agentBodySchemas';
import { registerAgentLifecycleControlRoutes } from './agentLifecycleControls';
import { upgradeLegacyAnchor } from '../../host/tools/artifacts/artifactLocatorHost';
import type {
  AgentSessionManagerLike,
  SupabaseAgentBinding,
} from './agentRouteTypes';
import type { WebRouteLogger } from './routeTypes';
import { sanitizeAttachmentsForPersistence, stripInlineAttachmentBlocks } from '../../shared/utils/messageAttachments';
import { composeDesignCanvasSystemPrompt } from '../../shared/design/canvasSessionReminder';
import { AgentRunController } from './agentRunController';
import { AgentRunEventCollector } from './agentRunEventCollector';
import { RunRegistry, RunSessionConflictError } from '../../host/runtime/runRegistry';
import {
  type RunControlTarget,
  type RunContext,
  type RunHandle,
} from '../../host/runtime/runContext';
import {
  createBridgeToolDispatch,
  type PendingLocalToolCall,
} from './agentBridgeToolDispatch';
import {
  type AgentDurableRouteDeps,
  cancelDisconnectedAgentRouteRun,
  finishExternalAgentRouteRun,
  releaseAgentRouteRun,
  resolveAgentDurableActivation,
  startAgentRouteRun,
  terminalAgentRouteRunFailure,
  terminalAgentRouteRunSuccess,
} from './agentDurableRouteLifecycle';
import { registerAgentCancelRoute } from './registerAgentCancelRoute';

export type { PendingLocalToolCall } from './agentBridgeToolDispatch';

interface AgentRouterDeps extends AgentDurableRouteDeps {
  runRegistry: RunRegistry;
  pendingLocalToolCalls: Map<string, PendingLocalToolCall>;
  logger: WebRouteLogger;
  tryGetSessionManager: () => Promise<AgentSessionManagerLike | null>;
  tryGetCLISessionManager?: () => Promise<AgentSessionManagerLike | null>;
  getSupabaseForSession: () => Promise<SupabaseAgentBinding | null>;
}

export type ActiveAgentLoop = RunControlTarget;

function extractWorkingDirectory(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const workingDirectory = (value as { workingDirectory?: unknown }).workingDirectory;
  return typeof workingDirectory === 'string' && workingDirectory.trim().length > 0
    ? workingDirectory.trim()
    : undefined;
}

async function ensureDefaultWebWorkingDirectory(): Promise<string> {
  const dataDir = process.env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), '.code-agent');
  const workDir = path.join(dataDir, 'work');
  await fs.mkdir(workDir, { recursive: true });
  return workDir;
}

async function tryGetSharedCLISessionManager(): Promise<AgentSessionManagerLike | null> {
  if (!dbAvailable) return null;
  try {
    const { getSessionManager } = await import('../../cli/bootstrap');
    return getSessionManager();
  } catch {
    return null;
  }
}

function buildSessionTitle(prompt: string): string {
  return prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
}

function toWorkbenchMetadata(context?: ConversationEnvelopeContext): MessageMetadata | undefined {
  if (!context) return undefined;

  const workbench: WorkbenchMessageMetadata = {};
  if (context.workingDirectory !== undefined) {
    workbench.workingDirectory = context.workingDirectory;
  }
  if (context.routing) {
    workbench.routingMode = context.routing.mode;
    if (context.routing.targetAgentIds?.length) {
      workbench.targetAgentIds = [...context.routing.targetAgentIds];
    }
  }
  if (context.selectedSkillIds?.length) {
    workbench.selectedSkillIds = [...context.selectedSkillIds];
  }
  if (context.selectedConnectorIds?.length) {
    workbench.selectedConnectorIds = [...context.selectedConnectorIds];
  }
  if (context.selectedMcpServerIds?.length) {
    workbench.selectedMcpServerIds = [...context.selectedMcpServerIds];
  }
  if (context.designBrief) {
    workbench.designBrief = context.designBrief;
  }
  if (context.executionIntent) {
    workbench.executionIntent = { ...context.executionIntent };
  }
  if (context.runtimeInput) {
    workbench.runtimeInputMode = context.runtimeInput.mode;
    if (context.runtimeInput.delivery) {
      workbench.runtimeInputDelivery = context.runtimeInput.delivery;
    }
  }

  return Object.keys(workbench).length > 0 ? { workbench } : undefined;
}

export function createAgentRouter(deps: AgentRouterDeps): Router {
  const router = Router();
  const {
    runRegistry,
    pendingLocalToolCalls,
    logger,
    tryGetSessionManager,
    tryGetCLISessionManager: tryGetCLISessionManagerOverride,
    getSupabaseForSession,
  } = deps;
  const sessionStore = createWebSessionStore({
    tryGetSessionManager: tryGetCLISessionManagerOverride ?? tryGetSharedCLISessionManager,
    tryGetInfraSessionManager: tryGetSessionManager,
    logger,
    getDatabase: async () => {
      const { getDatabase } = await import('../../host/services/core/databaseService');
      return getDatabase();
    },
  });

  // ── Agent Run (SSE streaming) ──────────────────────────────────────
  router.post('/run', async (req: Request, res: Response) => {
    const parsedBody = AgentRunBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    const body = parsedBody.data;
    const { prompt, project, sessionDir, model, provider } = body;
    const clientMessageId = body.clientMessageId?.trim()
      ? body.clientMessageId.trim()
      : undefined;

    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    // 使用请求中的 sessionId，或生成一个临时的（web 模式兼容）
    const sessionId = body.sessionId?.trim() || `web-session-${randomUUID()}`;
    const durableActivation = resolveAgentDurableActivation(deps, res);
    if (durableActivation === null) return;
    let preflightDisconnected = res.destroyed;
    const markPreflightDisconnected = (): void => {
      preflightDisconnected = true;
    };
    res.once('close', markPreflightDisconnected);

    // Preflight must finish before writeHead so a same-session race can be
    // rejected with an HTTP 409 instead of a misleading 200 SSE stream.
    let persistedSession: Session | null = null;
    let sessionManagerForRun: AgentSessionManagerLike | null = null;
    try {
      const sm = await tryGetSessionManager();
      sessionManagerForRun = sm ?? null;
      if (sm?.getSession) {
        persistedSession = await sm.getSession(sessionId, 1);
      }
    } catch (err) {
      logger.warn(`[AgentRouter] Failed to restore session ${sessionId}:`, err);
    }

    let resolvedProject: string | undefined =
      typeof project === 'string' && project.trim().length > 0
        ? project.trim()
        : typeof sessionDir === 'string' && sessionDir.trim().length > 0
          ? sessionDir.trim()
          : extractWorkingDirectory(body.context);
    if (!resolvedProject) {
      const fromSession = persistedSession?.workingDirectory?.trim();
      if (fromSession) resolvedProject = fromSession;
    }
    if (!resolvedProject) {
      try {
        resolvedProject = await ensureDefaultWebWorkingDirectory();
        logger.info(`[AgentRouter] No project/sessionDir/context workingDirectory, falling back to app work dir ${resolvedProject}`);
      } catch (error) {
        res.status(500).json({ error: formatError(error), code: 'RUN_WORKSPACE_UNAVAILABLE' });
        return;
      }
    }

    const selectedEngine = normalizeAgentEngineSession(persistedSession?.engine);

    // per-token 并发上限（WP3-4，fail-closed）：必须在 writeHead 之前拒。
    const releaseSseSlot = agentRunSseLimiter.tryAcquire(extractRequestToken(req));
    if (!releaseSseSlot) {
      res.status(429).json({ error: 'Too many concurrent runs for this token', code: 'TOO_MANY_CONNECTIONS' });
      return;
    }

    let runContext: RunContext | undefined;
    let runHandle: RunHandle | undefined;
    let externalDurableLifecycle: Awaited<ReturnType<typeof startAgentRouteRun>>['externalLifecycle'];
    let nativeRunTerminal = false;
    let runCorrelationId: string;
    try {
      const started = await startAgentRouteRun({
        runRegistry,
        sessionId,
        workspace: resolvedProject,
        durableActivation,
        externalEngine: isExternalAgentEngine(selectedEngine.kind) ? selectedEngine.kind : undefined,
      });
      runHandle = started.runHandle;
      externalDurableLifecycle = started.externalLifecycle;
      runContext = runHandle.context;
      runCorrelationId = runContext.runId;
    } catch (error) {
      releaseSseSlot();
      if (error instanceof RunSessionConflictError) {
        res.status(409).json({
          error: error.message,
          code: error.code,
          sessionId,
          activeRunId: error.existingRunId,
        });
        return;
      }
      if (!preflightDisconnected && !res.destroyed) {
        res.status(500).json({ error: formatError(error), code: 'RUN_REGISTRATION_FAILED' });
      }
      return;
    }

    res.once('close', releaseSseSlot);
    if (preflightDisconnected || res.destroyed) {
      if (runHandle) {
        await cancelDisconnectedAgentRouteRun({ runRegistry, runHandle, sessionId, durableActivation });
      }
      res.off('close', markPreflightDisconnected);
      releaseSseSlot();
      return;
    }

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const taskId = `task-${Date.now()}`;
    const runController = new AgentRunController({
      res,
      runId: runCorrelationId,
      sessionId,
      runHandle,
      logger,
      tryGetSessionManager,
    });

    res.once('close', runController.cancelForDisconnect);
    res.off('close', markPreflightDisconnected);
    if (preflightDisconnected || res.destroyed) {
      runController.cancelForDisconnect();
    }
    runController.emitSSE('task_start', {
      taskId,
      prompt,
      sessionId,
      ...(runHandle ? { runId: runHandle.context.runId } : {}),
    });
    await runController.updateSessionStatus('running');

    let externalEngineFailureContext: ExternalAgentEngineFailureContext | undefined;

    try {
      if (runController.disconnected) {
        await runController.updateSessionStatus('interrupted');
        return;
      }
      // 解析有效的 model/provider:body 显式参数 > session override > 默认。
      // 切换 UI 把模型写进 modelSessionState 后,/api/run 必须从这里读,
      // 否则 UI 切换看似生效但推理仍走 default(实测:UI 选 deepseek,日志仍 xiaomi)。
      let effectiveModel = model;
      let effectiveProvider = provider;
      // 自动模式（override.adaptive=true）：不用 override 的占位模型（保持默认模型），
      // 但必须把 adaptive 标志透传进 agent loop 的 modelConfig，
      // 否则 adaptiveRouter 简单任务路由 / vision capability fallback 全部失效
      //（实测 0.16.89：UI 选"自动"后日志仍报"显式模型 ... 不启用 vision fallback"）。
      let sessionAdaptive = false;
      // 只有 model 和 provider 都未显式给出才读 session override（audit R1-MED2：
      // 半显式 body（只传 model）不能拿 override 的 provider 拼成杂交配置，
      // 例如显式 deepseek-chat + 持久化 zhipu override → zhipu/deepseek-chat）。
      if (!effectiveModel && !effectiveProvider) {
        const { getModelSessionState } = await import('../../host/session/modelSessionState');
        const { rehydrateModelOverrideFromSession } = await import('../../host/session/modelOverridePersistence');
        // 重启后内存 Map 为空：按 session 持久化标记回灌（模板=engine 的"DB 列每轮现读"）。
        // 未切换过的会话没有标记，不回灌，仍跟随全局默认。
        const override = getModelSessionState().getOverride(sessionId)
          ?? rehydrateModelOverrideFromSession(persistedSession);
        if (override?.adaptive === true) {
          sessionAdaptive = true;
        } else if (override) {
          effectiveProvider = override.provider;
          effectiveModel = override.model;
        }
      }

      const { createCLIAgent } = await import('../../cli/adapter');
      const { createAgentLoop, createRunToolExecutor } = await import('../../cli/bootstrap');

      // 首轮生效值补写（只补空）：working_directory 为空的会话每次重开都按
      // 上面的解析链重解析，而 context.workingDirectory 来自 renderer 全局
      // workspace 值（随其他会话切目录漂移）→ 同一会话隔天 <env> 目录漂移。
      // 已持久化的值（用户显式选择或既有补写）不覆盖。
      if (
        persistedSession &&
        !persistedSession.workingDirectory?.trim() &&
        resolvedProject &&
        sessionManagerForRun?.updateSession
      ) {
        try {
          await sessionManagerForRun.updateSession(sessionId, {
            workingDirectory: resolvedProject,
            updatedAt: Date.now(),
          });
        } catch (err) {
          logger.warn(`[AgentRouter] Failed to backfill workingDirectory for ${sessionId}:`, err);
        }
      }

      if (isExternalAgentEngine(selectedEngine.kind)) {
        // 外部引擎分支在 preferredAgentId 路由真相块之前 return——显式 agent 选择
        // 在引擎会话不适用，此前完全静默（chip 继续谎报）。发降级事件让 renderer
        // 清选择 + toast（对称于 native 路径的解析失败降级）。
        const enginePreferredAgentId = typeof body.context?.preferredAgentId === 'string'
          ? body.context.preferredAgentId.trim() || undefined
          : undefined;
        if (enginePreferredAgentId) {
          const { buildRoutingResolvedEventData } = await import('../../host/agent/routingResolvedEvent');
          const engineLabel = AGENT_ENGINE_LABELS[selectedEngine.kind] ?? selectedEngine.kind;
          runController.emitAgentEvent({
            type: 'routing_resolved',
            data: buildRoutingResolvedEventData(null, {
              requestedAgentId: enginePreferredAgentId,
              timestamp: Date.now(),
              fallbackAgentName: engineLabel,
              fallbackReason: `External engine session (${engineLabel}) does not support agent selection; the engine runs the turn directly.`,
            }),
          });
          logger.info('[AgentRouter] Explicit agent selection ignored on external engine session', {
            preferredAgentId: enginePreferredAgentId,
            engine: selectedEngine.kind,
            sessionId,
          });
        }
        externalEngineFailureContext = {
          kind: selectedEngine.kind,
          stage: 'launch_policy',
          cwd: resolvedProject,
        };
        const launch = resolveExternalEngineLaunch(persistedSession, selectedEngine, resolvedProject);
        externalEngineFailureContext = {
          kind: selectedEngine.kind,
          stage: 'adapter_run',
          cwd: launch.cwd,
        };
        // codex/claude 走签名 catalog 的 resolveModelId；mimo/kimi 未注册签名 catalog，
        // resolveModelId 对未注册 kind 返回 undefined 会丢掉用户所选模型，故直传 launch.model。
        let adapter: CodexCliAdapter | ClaudeCodeAdapter | MimoCliAdapter | KimiCliAdapter;
        let resolvedEngineModel: string | undefined;
        if (selectedEngine.kind === 'codex_cli') {
          adapter = new CodexCliAdapter();
          resolvedEngineModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('codex_cli', launch.model, { strict: true });
        } else if (selectedEngine.kind === 'claude_code') {
          adapter = new ClaudeCodeAdapter();
          resolvedEngineModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('claude_code', launch.model, { strict: true });
        } else if (selectedEngine.kind === 'mimo_code') {
          adapter = new MimoCliAdapter();
          resolvedEngineModel = launch.model;
        } else {
          adapter = new KimiCliAdapter();
          resolvedEngineModel = launch.model;
        }
        const result = await adapter.run({
          sessionId,
          prompt,
          cwd: launch.cwd,
          workspaceRoot: launch.workspaceRoot,
          model: resolvedEngineModel,
          permissionProfile: launch.permissionProfile,
          clientMessageId,
          attachmentsCount: body.attachments?.length ?? 0,
          messageMetadata: toWorkbenchMetadata(body.context),
          emitEvent: (event) => runController.emitAgentEvent(event),
          durableLifecycle: externalDurableLifecycle,
        });
        nativeRunTerminal = await finishExternalAgentRouteRun(externalDurableLifecycle, result);
        runController.flush();
        await runController.updateSessionStatus(result.status === 'failed' ? 'error' : 'completed');
        return;
      }

      if (!runContext || !runHandle) {
        throw new Error('Native run is missing its RunContext or RunHandle');
      }

      const agent = await createCLIAgent({
        project: resolvedProject,
        model: effectiveModel,
        provider: effectiveProvider,
        json: true,
      });

      const config = agent.getConfig();

      // 每轮执行意图透传（web HTTP 路径）：renderer 的 context.executionIntent 必须进 AgentLoop
      // config → RuntimeContext.executionIntent，否则设计会话的 designCanvasActive 丢失，画布工具
      // 不会提进工具表、shell 代码画图守卫也不触发（桌面 Electron 路径经 agentAppService 已透传，
      // web 这条独立 HTTP 路径此前漏接）。
      if (body.context?.executionIntent) {
        config.executionIntent = { ...body.context.executionIntent };
      }

      // 自动模式标志透传：adaptiveRouter 简单任务路由 + vision capability fallback 的总闸门
      if (sessionAdaptive) {
        config.modelConfig.adaptive = true;
      }

      // /agent 显式选择透传（P0：此前 web 独立 HTTP 路径完全丢弃 preferredAgentId，
      // /agent 切换在生产 web 路径是 no-op——与 executionIntent 当年同款漏接）。
      // trim 规整：未规整 id 会在 requestedAgentId !== agentId 比较上产生假降级警示
      const preferredAgentId = typeof body.context?.preferredAgentId === 'string'
        ? body.context.preferredAgentId.trim() || undefined
        : undefined;
      if (preferredAgentId) {
        const { resolveExplicitAgentOverride } = await import('../../host/agent/explicitAgentOverride');
        const { buildRoutingResolvedEventData } = await import('../../host/agent/routingResolvedEvent');
        const agentOverride = resolveExplicitAgentOverride(preferredAgentId);
        // 路由真相事件：命中/失败都发射 routing_resolved（此前失败只打 warn 日志，
        // renderer 零信号=静默兜底；徽标/路由证据在生产 web 路径恒空）。
        // requestedAgentId 同时进 config → AgentLoop ctx → turnQuality 徽标降级判定。
        config.requestedAgentId = preferredAgentId;
        if (agentOverride) {
          config.agentOverride = agentOverride;
          runController.emitAgentEvent({
            type: 'routing_resolved',
            data: buildRoutingResolvedEventData(
              {
                agent: { id: agentOverride.id, name: agentOverride.name },
                score: 1000,
                reason: `Explicit agent selected: ${agentOverride.id}`,
              },
              { requestedAgentId: preferredAgentId, timestamp: Date.now() },
            ),
          });
          logger.info('[AgentRouter] Explicit agent override applied', {
            agentId: agentOverride.id,
            deniedTools: agentOverride.deniedToolNames.length,
            sessionId,
          });
        } else {
          runController.emitAgentEvent({
            type: 'routing_resolved',
            data: buildRoutingResolvedEventData(null, { requestedAgentId: preferredAgentId, timestamp: Date.now() }),
          });
          logger.warn('[AgentRouter] Unknown preferredAgentId, falling back to default routing', { preferredAgentId, sessionId });
        }
      }

      // /goal 自治模式：body.goal 存在则激活（schema 保证 verify/review 至少有一个）。
      // 设 config.goalContract → agentLoop 据此建 ctx.goalMode + maxIterations=maxTurns + 预加载 attempt_completion。
      if (body.goal) {
        config.goalContract = buildGoalContract({
          goal: body.goal.goal ?? prompt,
          verifyCommand: body.goal.verify,
          reviewCondition: body.goal.review,
          tokenBudget: body.goal.budget,
          maxTurns: body.goal.maxTurns,
          allowSwarm: body.goal.allowSwarm,
        });
        logger.info('[AgentRouter] Goal mode activated', { verify: body.goal.verify, review: body.goal.review, allowSwarm: body.goal.allowSwarm, sessionId });
      }

      const runModelConfig = {
        provider: config.modelConfig.provider,
        model: config.modelConfig.model,
      };

      // Bug 4 fix: 注入 Web 模式上下文，避免 Agent 默认以 CLI 模式自居
      if (!config.systemPrompt) {
        config.systemPrompt = 'You are running in Web UI mode (browser-based interface), not CLI/terminal mode. Users interact with you through a web chat interface with rich rendering support (markdown, code blocks, images). Respond accordingly.';
      }

      // 设计画布会话冷启动引导：按轮服务端注入 systemPrompt（不进用户 content，免污染历史提示词）。
      config.systemPrompt = composeDesignCanvasSystemPrompt(
        config.systemPrompt,
        config.executionIntent?.designCanvasActive,
      );

      // Fix: CLI config maps 'anthropic' but provider is 'claude'
      // Ensure apiKey is populated from env if missing
      if (!config.modelConfig.apiKey) {
        const providerEnvMap: Record<string, string> = {
          claude: 'ANTHROPIC_API_KEY',
          openai: 'OPENAI_API_KEY',
          deepseek: 'DEEPSEEK_API_KEY',
          gemini: 'GEMINI_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          groq: 'GROQ_API_KEY',
          moonshot: 'MOONSHOT_API_KEY',
          xiaomi: 'XIAOMI_API_KEY',
        };
        const envKey = providerEnvMap[config.modelConfig.provider];
        if (envKey && process.env[envKey]) {
          config.modelConfig.apiKey = process.env[envKey];
        }
      }

      // ── 构建消息历史（多轮上下文）──
      const requestAttachments = body.attachments ?? [];
      const persistedAttachments = sanitizeAttachmentsForPersistence(requestAttachments);
      const visiblePrompt = stripInlineAttachmentBlocks(prompt);
      const msgId = clientMessageId || `msg-${Date.now()}`;
      // ADR-040：renderer 只报它诚实知道的坐标，revision 在这里读源文件现算。
      // 升不上去（PPT / 缺 sheetName / 文件读不到）就没有 locator，退回 legacy 行为。
      const artifactLocator = body.context?.localityAnchor
        ? await upgradeLegacyAnchor(body.context.localityAnchor)
        : null;
      const userMsg: CachedMessage & { role: 'user' } = {
        id: msgId,
        role: 'user' as const,
        content: visiblePrompt,
        timestamp: Date.now(),
        attachments: persistedAttachments,
        ...(artifactLocator ? { metadata: { artifactLocator } } : {}),
      };

      // 加载历史消息 + 当前用户消息
      const cachedHistory = await sessionStore.loadSessionHistoryForRun(sessionId);
      const history = cachedHistory.map(({ id, role, content, timestamp, attachments, metadata }) => ({
        id,
        role: role as 'user' | 'assistant',
        content: stripInlineAttachmentBlocks(content),
        timestamp,
        attachments: sanitizeAttachmentsForPersistence(attachments),
        metadata,
      }));
      const messages = [...history, userMsg] as import('../../shared/contract').Message[];

      // ── Tool Executor 选择 ──
      // webServer 本身是 Node.js 进程，默认用当前 run 独占的 executor 执行本地工具。
      // 仅当 BRIDGE_MODE=true（远程部署）时才走 Bridge 代理路径。
      const useBridge = process.env.BRIDGE_MODE === 'true';
      const bridgeDispatch = useBridge
        ? createBridgeToolDispatch({
          runContext,
          pendingLocalToolCalls,
          emitSSE: (event, data) => runController.emitSSE(event, data),
          logger,
          traceContext: runHandle.traceContext,
        })
        : undefined;
      const runToolExecutor = createRunToolExecutor(runContext, bridgeDispatch);

      const runEventCollector = new AgentRunEventCollector({
        sessionId,
        emitToolWarning: (data) => runController.emitSSE('tool_warning', data),
      });

      const agentLoop = createAgentLoop(config, (event) => {
        const emitted = runController.emitAgentEvent(event);
        runEventCollector.observe(event, emitted);
      }, messages, sessionId, undefined, runToolExecutor, runContext, runHandle.traceContext);

      await runHandle.attach(agentLoop);
      if (runController.disconnected) {
        logger.warn(`[AgentRouter] Client disconnected before run ${runContext.runId} attached`);
      }

      // 新会话时立即通知前端刷新列表（不等 agentLoop 完成）
      if (history.length === 0) {
        const title = visiblePrompt.length > 30 ? visiblePrompt.substring(0, 30) + '...' : visiblePrompt;
        broadcastSSE('session:updated', { sessionId, updates: { title } });
        broadcastSSE('session:list-updated', undefined);
      }

      // === pre-persist user message before agentLoop.run ===
      // 把 user msg 在 run 之前落库,避免 cancel/abort/异常时 user prompt 丢失。
      // assistant/tool 消息由 messageProcessor 在 run 中自己落库,这里只补 user。
      let userMsgPrePersistedDb = false;
      let userMsgPrePersistedSupabase = false;

      userMsgPrePersistedDb = await sessionStore.prePersistUserMessage({
        sessionId,
        title: buildSessionTitle(visiblePrompt),
        modelConfig: { provider: runModelConfig.provider as ModelProvider, model: runModelConfig.model },
        message: {
          id: msgId,
          role: 'user',
          content: visiblePrompt,
          timestamp: userMsg.timestamp,
          attachments: userMsg.attachments,
        },
      });

      try {
        const sb = await getSupabaseForSession();
        if (sb) {
          const title = buildSessionTitle(visiblePrompt);
          await sb.supabase.from('sessions').upsert({
            id: sessionId,
            user_id: sb.userId,
            title,
            model_provider: runModelConfig.provider,
            model_name: runModelConfig.model,
            created_at: Date.now(),
            updated_at: Date.now(),
            source_device_id: 'web',
          }, { onConflict: 'id' });
          await sb.supabase.from('messages').insert({
            id: msgId,
            session_id: sessionId,
            user_id: sb.userId,
            role: 'user',
            content: visiblePrompt,
            timestamp: userMsg.timestamp,
            updated_at: Date.now(),
            source_device_id: 'web',
          });
          userMsgPrePersistedSupabase = true;
        }
      } catch (err) {
        logger.warn('Pre-persist user message to Supabase failed (continuing run):', (err as Error).message);
      }

      if (runHandle.cancellationRequested) {
        const cancelledEvent: import('../../shared/contract').AgentEvent = {
          type: 'agent_cancelled',
          data: null,
        };
        runEventCollector.observe(cancelledEvent, runController.emitAgentEvent(cancelledEvent));
      } else {
        await agentLoop.run(visiblePrompt);
      }

      const { assistantMsgId } = await sessionStore.commitTurn({
        sessionId,
        title: buildSessionTitle(visiblePrompt),
        modelConfig: runModelConfig,
        historyLength: history.length,
        userMessagePrePersistedDb: userMsgPrePersistedDb,
        userMessage: userMsg,
        turn: runEventCollector,
      });

      // ── 持久化到 Supabase（Web 模式云端同步）──
      try {
        const sb = await getSupabaseForSession();
        if (sb) {
          const title = visiblePrompt.length > 30 ? visiblePrompt.substring(0, 30) + '...' : visiblePrompt;
          // Upsert session
          await sb.supabase.from('sessions').upsert({
            id: sessionId,
            user_id: sb.userId,
            title,
            model_provider: runModelConfig.provider,
            model_name: runModelConfig.model,
            created_at: Date.now(),
            updated_at: Date.now(),
            source_device_id: 'web',
          }, { onConflict: 'id' });
          // Insert user message (skip if pre-persisted)
          if (!userMsgPrePersistedSupabase) {
            await sb.supabase.from('messages').insert({
              id: msgId,
              session_id: sessionId,
              user_id: sb.userId,
              role: 'user',
              content: visiblePrompt,
              timestamp: userMsg.timestamp,
              updated_at: Date.now(),
              source_device_id: 'web',
            });
          }
          // Insert assistant message
          if (!runEventCollector.runCancelled && runEventCollector.hasAssistantOutput()) {
            await sb.supabase.from('messages').insert({
              id: assistantMsgId,
              session_id: sessionId,
              user_id: sb.userId,
              role: 'assistant',
              content: runEventCollector.assistantText,
              tool_calls: runEventCollector.assistantToolCalls.length > 0 ? JSON.stringify(runEventCollector.assistantToolCalls) : null,
              thinking: runEventCollector.assistantThinking || null,
              timestamp: Date.now(),
              updated_at: Date.now(),
              source_device_id: 'web',
            });
          }
          // 更新会话标题（第一轮消息时）
          if (history.length === 0) {
            await sb.supabase.from('sessions').update({ title, updated_at: Date.now() }).eq('id', sessionId);
          }
        }
      } catch (sbErr) {
        logger.warn('Failed to persist messages to Supabase:', (sbErr as Error).message);
      }

      const finalStatus: SessionStatus = runEventCollector.runCancelled
        ? 'interrupted'
        : runController.hadTerminalError
          ? 'error'
          : 'completed';
      await runController.updateSessionStatus(finalStatus);

      nativeRunTerminal = await terminalAgentRouteRunSuccess({
        runRegistry, runHandle, sessionId, finalStatus, durableActivation,
      });

      // session:updated 和 session:list-updated 已按运行状态广播

      // 发送 agent_complete（useAgent 依赖此事件清除处理状态）
      runController.emitAgentEvent({ type: 'agent_complete', data: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (externalEngineFailureContext) {
        recordExternalEngineFailure({
          sessionId,
          message,
          context: externalEngineFailureContext,
        }, logger);
      }
      await runController.updateSessionStatus('error');
      nativeRunTerminal = await terminalAgentRouteRunFailure({
        runRegistry,
        runHandle,
        externalLifecycle: externalDurableLifecycle,
        terminal: nativeRunTerminal,
        durableActivation,
        disconnected: runController.disconnected,
        sessionId,
        message,
        logger,
      });
      if (!runController.disconnected) {
        runController.emitAgentEvent({
          type: 'error',
          data: {
            message,
          },
        });
      }
    } finally {
      runController.markSettled();
      res.off('close', runController.cancelForDisconnect);
      await releaseAgentRouteRun({
        runRegistry, runHandle, terminal: nativeRunTerminal, durableActivation,
      });
      runController.destroy();
      // Telemetry: 结束会话追踪（写入聚合指标到 telemetry_sessions）
      try {
        const { getTelemetryCollector } = await import('../../host/telemetry');
        const collector = getTelemetryCollector();
        collector.endSession(sessionId);
      } catch { /* telemetry cleanup failure is non-fatal */ }
      runController.endResponseIfOpen();
      releaseSseSlot(); // 并发槽位释放兜底（与 res 'close' 双保险，release 幂等）
    }
  });

  registerAgentCancelRoute(router, runRegistry, deps.getDurableRunReadService);

  registerAgentLifecycleControlRoutes(router, runRegistry, deps.getDurableRunReadService?.());

  router.post('/interrupt', async (req: Request, res: Response) => {
    const rawBody: unknown = req.body;
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? rawBody as Record<string, unknown>
      : {};
    const content = stripInlineAttachmentBlocks(typeof body.content === 'string'
      ? body.content
      : typeof body.prompt === 'string'
        ? body.prompt
        : '');
    const runId = typeof body.runId === 'string' ? body.runId : undefined;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : undefined;
    const attachments = Array.isArray(body.attachments)
      ? body.attachments as MessageAttachment[]
      : undefined;
    const context = body.context && typeof body.context === 'object'
      ? body.context as ConversationEnvelopeContext
      : undefined;

    if (!content.trim()) {
      res.status(400).json({ success: false, error: { code: 'INVALID_PAYLOAD', message: 'Missing interrupt content' } });
      return;
    }

    const activeLoop = runRegistry.resolve({ runId, sessionId });
    const targetSessionId = activeLoop?.context.sessionId;
    const targetRunId = activeLoop?.context.runId;

    if (
      !targetSessionId
      || !targetRunId
      || !activeLoop?.isAttached
      || activeLoop.cancellationRequested
    ) {
      res.status(409).json({
        success: false,
        error: {
          code: 'NO_ACTIVE_RUN',
          message: 'Agent not initialized for session',
        },
      });
      return;
    }

    broadcastSSE('agent:event', {
      type: 'interrupt_start',
      data: { message: '正在调整方向...', newUserMessage: content, runId: targetRunId },
      sessionId: targetSessionId,
    });

    try {
      await Promise.resolve(activeLoop.steer(
        content,
        clientMessageId,
        attachments,
        toWorkbenchMetadata(context),
      ));
      broadcastSSE('agent:event', {
        type: 'interrupt_complete',
        data: { message: '已调整方向', newUserMessage: content, runId: targetRunId },
        sessionId: targetSessionId,
      });
      res.json({ success: true, data: null });
    } catch (error) {
      logger.error(`[AgentRouter] Failed to interrupt active run for ${targetSessionId}:`, error);
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERRUPT_FAILED',
          message: formatError(error),
        },
      });
    }
  });

  // ── Tool Result (Local Bridge 前端回传工具执行结果) ────────────────
  router.post('/tool-result', (req: Request, res: Response) => {
    const parsedBody = AgentToolResultBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: 'Missing toolCallId' });
      return;
    }
    const { toolCallId, success, output, error, metadata } = parsedBody.data;
    const pending = pendingLocalToolCalls.get(toolCallId);
    if (!pending) {
      res.status(404).json({ error: `No pending tool call: ${toolCallId}` });
      return;
    }
    clearTimeout(pending.timer);
    pendingLocalToolCalls.delete(toolCallId);
    pending.resolve({
      success: !!success,
      output: output ?? undefined,
      error: error ?? undefined,
      metadata: metadata ?? undefined,
    });
    res.json({ message: 'Tool result received', toolCallId });
  });

  return router;
}
