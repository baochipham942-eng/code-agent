import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Message, MessageAttachment, MessageMetadata, Session, SessionStatus } from '../../shared/contract';
import type { ModelProvider } from '../../shared/contract/model';
import type {
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { AGENT_ENGINE_LABELS, normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import type { ExecuteOptions } from '../../host/tools/toolExecutor';
import type { DatabaseService } from '../../host/services/core/databaseService';
import { isLocalTool, mapToolName } from '../../shared/localTools';
import { broadcastSSE } from '../helpers/sse';
import { agentRunSseLimiter, extractRequestToken } from '../helpers/sseConnectionLimit';
import { formatError } from '../helpers/utils';
import {
  type CachedMessage,
  sessionMessages,
  SESSION_CACHE_MAX,
  inMemorySessions,
  dbAvailable,
  seedSessionMessagesFromPersisted,
} from '../helpers/sessionCache';
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
  AgentCancelBodySchema,
  AgentRunBodySchema,
  AgentToolResultBodySchema,
} from './agentBodySchemas';
import { registerAgentLifecycleControlRoutes } from './agentLifecycleControls';
import type {
  AgentSessionManagerLike,
  SupabaseAgentBinding,
} from './agentRouteTypes';
import type { WebRouteLogger } from './routeTypes';
import { sanitizeAttachmentsForPersistence, stripInlineAttachmentBlocks } from '../../shared/utils/messageAttachments';
import { extractArtifacts } from '../../host/agent/artifactExtractor';
import { composeDesignCanvasSystemPrompt } from '../../shared/design/canvasSessionReminder';
import { AgentRunController } from './agentRunController';
import { AgentRunEventCollector } from './agentRunEventCollector';

// ── Local Tool Bridge: 待处理的本地工具调用 ──
// key = toolCallId, value = { resolve, reject, timer }
export interface PendingLocalToolCall {
  resolve: (result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentRouterDeps {
  activeAgentLoops: Map<string, ActiveAgentLoop>;
  pendingLocalToolCalls: Map<string, PendingLocalToolCall>;
  logger: WebRouteLogger;
  tryGetSessionManager: () => Promise<AgentSessionManagerLike | null>;
  getSupabaseForSession: () => Promise<SupabaseAgentBinding | null>;
}

const LOCAL_TOOL_TIMEOUT_MS = 120_000; // 2 分钟超时

export interface ActiveAgentLoop {
  cancel(reason?: string): void | Promise<void>;
  pause?(): void | Promise<void>;
  resume?(): void | Promise<void>;
  steer?(
    newMessage: string,
    clientMessageId?: string,
    attachments?: MessageAttachment[],
    metadata?: MessageMetadata,
  ): void | Promise<void>;
}

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

function isDuplicateMessageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT');
}

async function ensureDbSession(
  sessionId: string,
  title: string,
  modelConfig: { provider: ModelProvider; model: string },
): Promise<DatabaseService> {
  const { getDatabase } = await import('../../host/services/core/databaseService');
  const db = getDatabase();
  const existing = db.getSession(sessionId);
  if (!existing) {
    db.createSessionWithId(sessionId, {
      title,
      modelConfig,
    });
  } else {
    // renderer 端常用 '新对话' 占位 title 先创建 session 行，再发 user message。
    // 这里在 session 已存在但 title 还是默认值时，用 prompt 派生的 title 升级一次，
    // 避免 sidebar 永远停在 '新对话'。
    const isDefaultTitle =
      !existing.title ||
      existing.title === '新对话' ||
      existing.title === 'New Chat' ||
      existing.title === 'New Session' ||
      (typeof existing.title === 'string' && existing.title.startsWith('Session '));
    if (isDefaultTitle && title && title !== existing.title) {
      try {
        db.updateSession(sessionId, { title, updatedAt: Date.now() });
      } catch {
        // 升级失败不阻塞主流程，下一轮 maybeUpdateTitleForSession 还会再试
      }
    }
  }
  return db;
}

async function persistMessageToDb(
  sessionManager: AgentSessionManagerLike | null,
  db: DatabaseService,
  sessionId: string,
  message: Message,
): Promise<void> {
  if (sessionManager?.addMessageToSession) {
    await sessionManager.addMessageToSession(sessionId, message);
    return;
  }

  try {
    db.addMessage(sessionId, message);
  } catch (error) {
    if (!isDuplicateMessageError(error)) {
      throw error;
    }
    db.updateMessage(message.id, message);
  }
}

async function loadSessionHistoryForRun(
  sessionId: string,
  tryGetSessionManager: AgentRouterDeps['tryGetSessionManager'],
  logger: AgentRouterDeps['logger'],
): Promise<CachedMessage[]> {
  const cached = sessionMessages.get(sessionId);
  if (cached?.length) {
    return cached;
  }

  try {
    const sm = await tryGetSessionManager();
    if (!sm?.getMessages) {
      return [];
    }

    const persisted = await sm.getMessages(sessionId);
    if (!Array.isArray(persisted) || persisted.length === 0) {
      return [];
    }

    const restored = seedSessionMessagesFromPersisted(sessionId, persisted);
    if (restored.length === 0) {
      logger.warn('[AgentRouter] Persisted session history had no user/assistant messages for run', {
        sessionId,
        persistedCount: persisted.length,
      });
    }
    return restored;
  } catch (error) {
    logger.warn(`[AgentRouter] Failed to hydrate persisted history for ${sessionId}:`, error);
    return [];
  }
}

// 兜底判定只认「终轮」assistant 是否落库：早轮已落库不能抑制兜底（终轮落库失败时
// 内容+metadata 会静默丢失）。兜底写的是本 run 合并全文，早轮已在库时触发会有部分
// 内容重复——丢终轮结论比重复早轮片段更不可接受，取舍偏向保内容。
async function hasPersistedFinalLoopAssistantMessage(
  sessionId: string,
  finalMessageId: string | undefined,
  sessionManager: AgentSessionManagerLike | null,
  db: DatabaseService,
  logger: AgentRouterDeps['logger'],
): Promise<boolean> {
  if (!finalMessageId) {
    return false;
  }

  try {
    const persisted = sessionManager?.getMessages
      ? await sessionManager.getMessages(sessionId)
      : db.getMessages(sessionId);

    return Array.isArray(persisted) && persisted.some((message) => (
      message.role === 'assistant' && message.id === finalMessageId
    ));
  } catch (error) {
    logger.warn(`[AgentRouter] Failed to verify loop-persisted assistant messages for ${sessionId}:`, error);
    return false;
  }
}

export function createAgentRouter(deps: AgentRouterDeps): Router {
  const router = Router();
  const {
    activeAgentLoops,
    pendingLocalToolCalls,
    logger,
    tryGetSessionManager,
    getSupabaseForSession,
  } = deps;

  // ── Agent Run (SSE streaming) ──────────────────────────────────────
  router.post('/run', async (req: Request, res: Response) => {
    const rawBody: unknown = req.body;
    const parsedBody = AgentRunBodySchema.safeParse(rawBody);
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

    // per-token 并发上限（WP3-4，fail-closed）：必须在 writeHead 之前拒——
    // text/event-stream 头一旦写出就无法再回 429。释放走 res 'close' + finally 双保险（release 幂等）。
    const releaseSseSlot = agentRunSseLimiter.tryAcquire(extractRequestToken(req));
    if (!releaseSseSlot) {
      res.status(429).json({ error: 'Too many concurrent runs for this token', code: 'TOO_MANY_CONNECTIONS' });
      return;
    }
    res.once('close', releaseSseSlot);

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const taskId = `task-${Date.now()}`;
    // 使用请求中的 sessionId，或生成一个临时的（web 模式兼容）
    const sessionId = body.sessionId || `web-session-${Date.now()}`;
    const runController = new AgentRunController({
      res,
      sessionId,
      activeAgentLoops,
      logger,
      tryGetSessionManager,
    });

    res.once('close', runController.cancelForDisconnect);
    runController.emitSSE('task_start', { taskId, prompt, sessionId });
    await runController.updateSessionStatus('running');

    let externalEngineFailureContext: ExternalAgentEngineFailureContext | undefined;

    try {
      // 解析有效的 model/provider:body 显式参数 > session override > 默认。
      // 切换 UI 把模型写进 modelSessionState 后,/api/run 必须从这里读,
      // 否则 UI 切换看似生效但推理仍走 default(实测:UI 选 deepseek,日志仍 xiaomi)。
      let effectiveModel = model;
      let effectiveProvider = provider;
      // 自动模式（override.adaptive=true）：不用 override 的占位模型（保持默认模型），
      // 但必须把 adaptive 标志透传进 agent loop 的 modelConfig，
      // 否则 adaptiveRouter 简单任务路由 / vision capability fallback 全部失效
      //（实测 0.16.89：UI 选"自动"后日志仍报"显式模型 ... 不启用 vision fallback"）。
      // persistedSession 先取：模型 override 回灌与 workingDirectory 解析都依赖它
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
      const { createAgentLoop } = await import('../../cli/bootstrap');

      // workingDirectory 解析顺序：
      // 1. body.project / body.sessionDir 显式传值
      // 2. body.context.workingDirectory（renderer 的 ConversationEnvelope）
      // 3. session 持久化的 workingDirectory（同会话恢复，避免每次都要重选）
      // 4. app 私有 work 目录。不能 fallback 到 HOME，否则普通聊天会扫描整台机器的 AGENTS/CLAUDE 文件。

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
        resolvedProject = await ensureDefaultWebWorkingDirectory();
        logger.info(`[AgentRouter] No project/sessionDir/context workingDirectory, falling back to app work dir ${resolvedProject}`);
      }

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

      const selectedEngine = normalizeAgentEngineSession(persistedSession?.engine);
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
        });
        runController.flush();
        await runController.updateSessionStatus(result.status === 'failed' ? 'error' : 'completed');
        return;
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
      const userMsg: CachedMessage = {
        id: msgId,
        role: 'user' as const,
        content: visiblePrompt,
        timestamp: Date.now(),
        attachments: persistedAttachments,
      };

      // 加载历史消息 + 当前用户消息
      const cachedHistory = await loadSessionHistoryForRun(sessionId, tryGetSessionManager, logger);
      const history = cachedHistory.map(({ id, role, content, timestamp, attachments }) => ({
        id,
        role: role as 'user' | 'assistant',
        content: stripInlineAttachmentBlocks(content),
        timestamp,
        attachments: sanitizeAttachmentsForPersistence(attachments),
      }));
      const messages = [...history, userMsg] as import('../../shared/contract').Message[];

      // ── Tool Executor 选择 ──
      // webServer 本身是 Node.js 进程，默认直接用 originalExecutor 执行本地工具。
      // 仅当 BRIDGE_MODE=true（远程部署）时才走 Bridge 代理路径。
      const useBridge = process.env.BRIDGE_MODE === 'true';
      const { getToolExecutor } = await import('../../cli/bootstrap');
      const originalExecutor = getToolExecutor();

      let bridgeToolExecutor = originalExecutor ? {
        execute: originalExecutor.execute.bind(originalExecutor),
        setWorkingDirectory: originalExecutor.setWorkingDirectory?.bind(originalExecutor),
        setAuditEnabled: originalExecutor.setAuditEnabled?.bind(originalExecutor),
      } : undefined;

      if (useBridge && originalExecutor) {
        // 远程部署模式：本地工具通过 Bridge 代理到用户机器执行
        const localToolProxy = {
          execute: async (toolName: string, params: Record<string, unknown>, _options: ExecuteOptions) => {
            if (!isLocalTool(toolName)) return null;

            const bridgeTool = mapToolName(toolName);
            const toolCallId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            runController.emitSSE('tool_call_local', {
              toolCallId,
              tool: bridgeTool,
              originalTool: toolName,
              params,
              permissionLevel: 'L1',
              sessionId,
            });

            return new Promise<{ success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }>((resolve) => {
              const timer = setTimeout(() => {
                pendingLocalToolCalls.delete(toolCallId);
                resolve({
                  success: false,
                  error: `Local tool '${toolName}' timed out after ${LOCAL_TOOL_TIMEOUT_MS / 1000}s waiting for Bridge response`,
                });
              }, LOCAL_TOOL_TIMEOUT_MS);

              pendingLocalToolCalls.set(toolCallId, { resolve, reject: () => { clearTimeout(timer); }, timer });
            });
          },
        };

        bridgeToolExecutor = {
          execute: async (toolName: string, params: Record<string, unknown>, options: ExecuteOptions) => {
            const proxyResult = await localToolProxy.execute(toolName, params, options);
            if (proxyResult === null) return originalExecutor.execute(toolName, params, options);
            // Bridge 连接失败时降级到本地执行
            if (!proxyResult.success && proxyResult.error?.includes('Bridge is not connected')) {
              logger.warn(`[BridgeProxy] Bridge down, falling back to local executor for: ${toolName}`);
              return originalExecutor.execute(toolName, params, options);
            }
            return proxyResult;
          },
          setWorkingDirectory: originalExecutor.setWorkingDirectory?.bind(originalExecutor),
          setAuditEnabled: originalExecutor.setAuditEnabled?.bind(originalExecutor),
        };
      }

      const runEventCollector = new AgentRunEventCollector({
        sessionId,
        emitToolWarning: (data) => runController.emitSSE('tool_warning', data),
      });

      const agentLoop = createAgentLoop(config, (event) => {
        const emitted = runController.emitAgentEvent(event);
        runEventCollector.observe(event, emitted);
      }, messages, sessionId, undefined, bridgeToolExecutor);

      // 存储当前 agentLoop 引用，供 cancel 使用
      activeAgentLoops.set(sessionId, agentLoop);
      if (runController.disconnected) {
        logger.warn(`[AgentRouter] Client already disconnected before run started; cancelling ${sessionId}`);
        await Promise.resolve(agentLoop.cancel('user'));
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

      if (dbAvailable) {
        try {
          const sm = await tryGetSessionManager();
          const db = await ensureDbSession(
            sessionId,
            buildSessionTitle(visiblePrompt),
            { provider: runModelConfig.provider as ModelProvider, model: runModelConfig.model },
          );
          await persistMessageToDb(sm, db, sessionId, {
            id: msgId,
            role: 'user',
            content: visiblePrompt,
            timestamp: userMsg.timestamp,
            attachments: userMsg.attachments,
          } as Message);
          userMsgPrePersistedDb = true;
        } catch (err) {
          logger.warn('Pre-persist user message to DB failed (continuing run):', (err as Error).message);
        }
      }

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

      await agentLoop.run(visiblePrompt);

      // ── 缓存会话消息（维持多轮上下文）──
      // 无论 assistantText 是否为空都要缓存 userMsg，否则工具-only 轮次会丢失上下文
      const assistantMsgId = `msg-${Date.now()}-a`;
      const cached = [...(sessionMessages.get(sessionId) || []), userMsg];
      const assistantArtifacts = runEventCollector.assistantText ? extractArtifacts(runEventCollector.assistantText) : [];
      if (!runEventCollector.runCancelled && runEventCollector.hasAssistantOutput()) {
        cached.push({
          id: assistantMsgId,
          role: 'assistant',
          content: runEventCollector.assistantText,
          timestamp: Date.now(),
          toolCalls: runEventCollector.assistantToolCalls.length > 0 ? runEventCollector.assistantToolCalls : undefined,
          thinking: runEventCollector.assistantThinking || undefined,
          contentParts: runEventCollector.hasInterleaving() ? runEventCollector.contentParts : undefined,
          artifacts: assistantArtifacts.length > 0 ? assistantArtifacts : undefined,
          metadata: runEventCollector.assistantMetadata,
        });
      }
      sessionMessages.set(sessionId, cached);

      // LRU 清理：超过上限时移除最旧的会话
      if (sessionMessages.size > SESSION_CACHE_MAX) {
        const oldestKey = sessionMessages.keys().next().value;
        if (oldestKey) sessionMessages.delete(oldestKey);
      }

      // ── 更新内存会话元数据 ──
      {
        const title = visiblePrompt.length > 30 ? visiblePrompt.substring(0, 30) + '...' : visiblePrompt;
        const existing = inMemorySessions.get(sessionId);
        if (existing) {
          existing.updatedAt = Date.now();
          existing.messageCount = (sessionMessages.get(sessionId) || []).length;
          if (history.length === 0) existing.title = title;
        } else {
          inMemorySessions.set(sessionId, {
            id: sessionId,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: (sessionMessages.get(sessionId) || []).length,
          });
        }
      }

      // ── 持久化到数据库（优先走 SM 保持缓存一致）──
      if (dbAvailable) {
        try {
          // 确保 session 在 DB 中存在（SM 和直写都需要）
          const { getDatabase: ensureDb } = await import('../../host/services/core/databaseService');
          const dbForSession = ensureDb();
          if (!dbForSession.getSession(sessionId)) {
            dbForSession.createSessionWithId(sessionId, {
              title: visiblePrompt.length > 30 ? visiblePrompt.substring(0, 30) + '...' : visiblePrompt,
              modelConfig: runModelConfig,
            });
          }

          const sm = await tryGetSessionManager();
          const loopPersistedAssistant = await hasPersistedFinalLoopAssistantMessage(
            sessionId,
            runEventCollector.lastLoopAssistantMessageId,
            sm,
            dbForSession,
            logger,
          );
          if (sm?.addMessageToSession) {
            // 通过 SM 写入，同时更新 DB 和 sessionCache
            if (!userMsgPrePersistedDb) {
              await sm.addMessageToSession(sessionId, {
                id: msgId,
                role: 'user',
                content: visiblePrompt,
                timestamp: userMsg.timestamp,
                attachments: userMsg.attachments,
              } as import('../../shared/contract').Message);
            }
            if (!runEventCollector.runCancelled && runEventCollector.hasAssistantOutput() && !loopPersistedAssistant) {
              await sm.addMessageToSession(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: runEventCollector.assistantText,
                timestamp: Date.now(),
                toolCalls: runEventCollector.assistantToolCalls.length > 0 ? runEventCollector.assistantToolCalls : undefined,
                thinking: runEventCollector.assistantThinking || undefined,
                artifacts: assistantArtifacts.length > 0 ? assistantArtifacts : undefined,
                metadata: runEventCollector.assistantMetadata,
              } as import('../../shared/contract').Message);
            }
          } else {
            // SM 不可用时降级为直写 DB（session 已在上面 ensure 创建）
            const { getDatabase } = await import('../../host/services/core/databaseService');
            const db = getDatabase();
            if (!userMsgPrePersistedDb) {
              db.addMessage(sessionId, {
                id: msgId,
                role: 'user',
                content: visiblePrompt,
                timestamp: userMsg.timestamp,
                attachments: userMsg.attachments,
              } as import('../../shared/contract').Message);
            }
            if (!runEventCollector.runCancelled && runEventCollector.hasAssistantOutput() && !loopPersistedAssistant) {
              db.addMessage(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: runEventCollector.assistantText,
                timestamp: Date.now(),
                toolCalls: runEventCollector.assistantToolCalls.length > 0 ? runEventCollector.assistantToolCalls : undefined,
                thinking: runEventCollector.assistantThinking || undefined,
                artifacts: assistantArtifacts.length > 0 ? assistantArtifacts : undefined,
                metadata: runEventCollector.assistantMetadata,
              } as import('../../shared/contract').Message);
            }
          }
          // 更新会话标题/时间戳
          const { getDatabase: getDb } = await import('../../host/services/core/databaseService');
          const db = getDb();
          if (history.length === 0) {
            const title = visiblePrompt.length > 30 ? visiblePrompt.substring(0, 30) + '...' : visiblePrompt;
            db.updateSession(sessionId, { title, updatedAt: Date.now() });
          } else {
            db.updateSession(sessionId, { updatedAt: Date.now() });
          }
        } catch (dbErr) {
          logger.warn('Failed to persist messages to DB:', (dbErr as Error).message);
        }
      }

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
      activeAgentLoops.delete(sessionId);
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

  // ── Cancel ─────────────────────────────────────────────────────────
  router.post('/cancel', async (req: Request, res: Response) => {
    const rawBody: unknown = req.body;
    const parsedBody = AgentCancelBodySchema.safeParse(rawBody);
    const sessionId = parsedBody.success ? parsedBody.data.sessionId : undefined;
    const requestedLoop = sessionId ? activeAgentLoops.get(sessionId) : undefined;
    if (sessionId && requestedLoop) {
      await Promise.resolve(requestedLoop.cancel());
      activeAgentLoops.delete(sessionId);
      res.json({ message: 'Cancelled', sessionId });
    } else if (activeAgentLoops.size > 0) {
      // 没指定 sessionId 时取消最后一个
      const lastEntry = [...activeAgentLoops.entries()].at(-1);
      if (!lastEntry) {
        res.json({ message: 'No active agent to cancel' });
        return;
      }
      const [lastKey, lastLoop] = lastEntry;
      await Promise.resolve(lastLoop.cancel());
      activeAgentLoops.delete(lastKey);
      res.json({ message: 'Cancelled', sessionId: lastKey });
    } else {
      res.json({ message: 'No active agent to cancel' });
    }
  });

  registerAgentLifecycleControlRoutes(router, activeAgentLoops);

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

    const activeLoopEntry = sessionId
      ? [sessionId, activeAgentLoops.get(sessionId)] as const
      : [...activeAgentLoops.entries()].at(-1);
    const targetSessionId = activeLoopEntry?.[0];
    const activeLoop = activeLoopEntry?.[1];

    if (!targetSessionId || !activeLoop || typeof activeLoop.steer !== 'function') {
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
      data: { message: '正在调整方向...', newUserMessage: content },
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
        data: { message: '已调整方向', newUserMessage: content },
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
    const rawBody: unknown = req.body;
    const parsedBody = AgentToolResultBodySchema.safeParse(rawBody);
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
