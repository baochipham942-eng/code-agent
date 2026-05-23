import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentEvent, Message, MessageAttachment, MessageMetadata, Session, SessionStatus } from '../../shared/contract';
import type { ModelProvider } from '../../shared/contract/model';
import type {
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import type { ExecuteOptions } from '../../main/tools/toolExecutor';
import type { DatabaseService } from '../../main/services/core/databaseService';
import { isLocalTool, mapToolName } from '../../shared/localTools';
import { broadcastSSE, sendSSE } from '../helpers/sse';
import { createAgentRunSSEBatcher } from '../helpers/agentRunSSEBatcher';
import { formatError } from '../helpers/utils';
import {
  type CachedMessage,
  type CachedToolCall,
  sessionMessages,
  SESSION_CACHE_MAX,
  inMemorySessions,
  dbAvailable,
  seedSessionMessagesFromPersisted,
} from '../helpers/sessionCache';
import { MessageDeltaAccumulator } from '../../main/protocol/messageDeltaAccumulator';
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  getRemoteAgentEngineModelCatalogService,
  resolveExternalEngineLaunch,
} from '../../main/services/agentEngine';
import {
  type ExternalAgentEngineFailureContext,
  recordExternalEngineFailure,
} from './agentEngineFailureRecorder';
import {
  AgentCancelBodySchema,
  AgentRunBodySchema,
  AgentToolResultBodySchema,
} from './agentBodySchemas';
import type {
  AgentSessionManagerLike,
  SupabaseAgentBinding,
} from './agentRouteTypes';
import type { WebRouteLogger } from './routeTypes';

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

function isTerminalErrorEvent(event: AgentEvent): boolean {
  if (event.type !== 'error') return false;
  const payload = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  return payload.level !== 'warning'
    && payload.severity !== 'warning'
    && payload.terminal !== false;
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
  const { getDatabase } = await import('../../main/services/core/databaseService');
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

async function hasPersistedLoopAssistantMessage(
  sessionId: string,
  messageIds: Set<string>,
  sessionManager: AgentSessionManagerLike | null,
  db: DatabaseService,
  logger: AgentRouterDeps['logger'],
): Promise<boolean> {
  if (messageIds.size === 0) {
    return false;
  }

  try {
    const persisted = sessionManager?.getMessages
      ? await sessionManager.getMessages(sessionId)
      : db.getMessages(sessionId);

    return Array.isArray(persisted) && persisted.some((message) => (
      message.role === 'assistant' && messageIds.has(message.id)
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
    const { prompt, project, sessionDir, model, provider, generation } = body;
    const clientMessageId = body.clientMessageId?.trim()
      ? body.clientMessageId.trim()
      : undefined;

    if (!prompt) {
      res.status(400).json({ error: 'Missing prompt' });
      return;
    }

    // SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const taskId = `task-${Date.now()}`;
    // 使用请求中的 sessionId，或生成一个临时的（web 模式兼容）
    const sessionId = body.sessionId || `web-session-${Date.now()}`;
    let runSettled = false;
    let clientDisconnected = false;
    let runHadTerminalError = false;
    let terminalCompletionEmitted = false;

    const canWriteSSE = () => !res.writableEnded && !res.destroyed;
    const emitSSE = (event: string, data: unknown) => {
      if (!canWriteSSE()) return;
      try {
        sendSSE(res, event, data);
      } catch (error) {
        logger.warn(`[AgentRouter] Failed to write SSE event ${event} for ${sessionId}:`, error);
      }
    };
    const agentSSEBatcher = createAgentRunSSEBatcher(emitSSE, sessionId);
    const messageAccumulator = new MessageDeltaAccumulator();
    const emitAgentEvent = (event: AgentEvent): boolean => {
      if (isTerminalErrorEvent(event)) {
        runHadTerminalError = true;
      }
      // 终态完成事件（agent_complete/agent_cancelled）幂等去重：runFinalizer 经 onEvent 已发过一次后，
      // route 末尾 line ~966 的兜底再发会重复（旧问题：clean run 双 agent_complete；cancel 时
      // agent_cancelled 之后又跟一个 agent_complete）。这里"终态只发一次"，让 line ~966 的兜底仅在
      // loop 自身未发终态（提前 return / 异常退出）时才真正生效。前端各 effect 把两种终态同等对待，
      // 故 cancel 时只发 agent_cancelled 也能正常清处理态。
      if (event.type === 'agent_complete' || event.type === 'agent_cancelled') {
        if (terminalCompletionEmitted) {
          return false;
        }
        terminalCompletionEmitted = true;
      }
      const snapshot = messageAccumulator.apply(sessionId, event);
      if (event.type === 'message_delta' && !snapshot) {
        return false;
      }
      const finalSnapshot = (
        event.type === 'turn_end'
        || event.type === 'agent_complete'
        || event.type === 'agent_cancelled'
      )
        ? messageAccumulator.getSnapshot(sessionId, true)
        : null;
      if (finalSnapshot) {
        agentSSEBatcher.emit({ type: 'message_snapshot', data: finalSnapshot });
      }
      agentSSEBatcher.emit(event);
      if (finalSnapshot) {
        messageAccumulator.clear(sessionId);
      }
      return true;
    };
    const updateRunSessionStatus = async (status: SessionStatus): Promise<void> => {
      const updates = { status, updatedAt: Date.now() };
      try {
        const sm = await tryGetSessionManager();
        if (sm?.updateSession) {
          await sm.updateSession(sessionId, updates);
        } else {
          const { getDatabase } = await import('../../main/services/core/databaseService');
          const db = getDatabase();
          if (db.isReady) {
            db.updateSession(sessionId, updates);
          }
        }
        broadcastSSE('session:updated', { sessionId, updates });
        broadcastSSE('session:list-updated', undefined);
      } catch (error) {
        logger.warn(`[AgentRouter] Failed to persist session status ${status} for ${sessionId}:`, error);
      }
    };
    const cancelForDisconnect = () => {
      if (runSettled || clientDisconnected) return;
      clientDisconnected = true;
      const activeLoop = activeAgentLoops.get(sessionId);
      if (!activeLoop) return;
      logger.warn(`[AgentRouter] SSE client disconnected, cancelling active run for ${sessionId}`);
      void Promise.resolve(activeLoop.cancel('user')).catch((error) => {
        logger.warn(`[AgentRouter] Failed to cancel disconnected run for ${sessionId}:`, error);
      });
    };

    res.once('close', cancelForDisconnect);
    emitSSE('task_start', { taskId, prompt, sessionId });
    await updateRunSessionStatus('running');

    let externalEngineFailureContext: ExternalAgentEngineFailureContext | undefined;

    try {
      // 解析有效的 model/provider:body 显式参数 > session override > 默认。
      // 切换 UI 把模型写进 modelSessionState 后,/api/run 必须从这里读,
      // 否则 UI 切换看似生效但推理仍走 default(实测:UI 选 deepseek,日志仍 xiaomi)。
      let effectiveModel = model;
      let effectiveProvider = provider;
      if (!effectiveModel || !effectiveProvider) {
        const { getModelSessionState } = await import('../../main/session/modelSessionState');
        const override = getModelSessionState().getOverride(sessionId);
        if (override && !override.adaptive) {
          effectiveProvider = effectiveProvider ?? override.provider;
          effectiveModel = effectiveModel ?? override.model;
        }
      }

      const { createCLIAgent } = await import('../../cli/adapter');
      const { createAgentLoop } = await import('../../cli/bootstrap');

      // workingDirectory 解析顺序：
      // 1. body.project / body.sessionDir 显式传值
      // 2. body.context.workingDirectory（renderer 的 ConversationEnvelope）
      // 3. session 持久化的 workingDirectory（同会话恢复，避免每次都要重选）
      // 4. app 私有 work 目录。不能 fallback 到 HOME，否则普通聊天会扫描整台机器的 AGENTS/CLAUDE 文件。
      let persistedSession: Session | null = null;
      try {
        const sm = await tryGetSessionManager();
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
        resolvedProject = await ensureDefaultWebWorkingDirectory();
        logger.warn(`[AgentRouter] No project/sessionDir/context workingDirectory, falling back to app work dir ${resolvedProject}`);
      }

      const selectedEngine = normalizeAgentEngineSession(persistedSession?.engine);
      if (selectedEngine.kind === 'codex_cli' || selectedEngine.kind === 'claude_code') {
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
        const adapter = selectedEngine.kind === 'codex_cli'
          ? new CodexCliAdapter()
          : new ClaudeCodeAdapter();
        const result = await adapter.run({
          sessionId,
          prompt,
          cwd: launch.cwd,
          workspaceRoot: launch.workspaceRoot,
          model: await getRemoteAgentEngineModelCatalogService().resolveModelId(selectedEngine.kind, launch.model),
          permissionProfile: launch.permissionProfile,
          clientMessageId,
          attachmentsCount: body.attachments?.length ?? 0,
          messageMetadata: toWorkbenchMetadata(body.context),
          emitEvent: (event) => emitAgentEvent(event),
        });
        agentSSEBatcher.flush();
        await updateRunSessionStatus(result.status === 'failed' ? 'error' : 'completed');
        return;
      }

      const agent = await createCLIAgent({
        project: resolvedProject,
        gen: generation,
        model: effectiveModel,
        provider: effectiveProvider,
        json: true,
      });

      const config = agent.getConfig();
      const runModelConfig = {
        provider: config.modelConfig.provider,
        model: config.modelConfig.model,
      };

      // Bug 4 fix: 注入 Web 模式上下文，避免 Agent 默认以 CLI 模式自居
      if (!config.systemPrompt) {
        config.systemPrompt = 'You are running in Web UI mode (browser-based interface), not CLI/terminal mode. Users interact with you through a web chat interface with rich rendering support (markdown, code blocks, images). Respond accordingly.';
      }

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
      // 将附件文本数据拼接到 prompt 中，使 Agent 能看到附件内容
      let enrichedPrompt = prompt;
      const requestAttachments = body.attachments ?? [];
      const imageAttachments = requestAttachments.filter((att) =>
        att.category === 'image' || att.type === 'image'
      );
      if (requestAttachments.length) {
        const textParts: string[] = [];
        for (const att of requestAttachments) {
          if ((att.category === 'image' || att.type === 'image')) {
            continue;
          }
          if (att.data && typeof att.data === 'string') {
            // 非图片附件：将文本数据注入到 prompt 中
            const label = att.name || att.category || 'attachment';
            textParts.push(`\n\n<attachment name="${label}" category="${att.category || 'file'}">\n${att.data}\n</attachment>`);
          }
        }
        if (textParts.length > 0) {
          enrichedPrompt = prompt + textParts.join('');
        }
      }
      const msgId = clientMessageId || `msg-${Date.now()}`;
      const userMsg: CachedMessage = {
        id: msgId,
        role: 'user' as const,
        content: enrichedPrompt,
        timestamp: Date.now(),
        attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      };

      // 加载历史消息 + 当前用户消息
      const cachedHistory = await loadSessionHistoryForRun(sessionId, tryGetSessionManager, logger);
      const history = cachedHistory.map(({ id, role, content, timestamp, attachments }) => ({
        id, role: role as 'user' | 'assistant', content, timestamp, attachments,
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

            emitSSE('tool_call_local', {
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

      // 收集助手回复（文本 + 工具调用 + 思考过程）
      let assistantText = '';
      let assistantThinking = '';
      let consecutiveToolFailures = 0;
      const assistantToolCalls: CachedToolCall[] = [];
      const toolResultMessages: CachedMessage[] = [];
      const loopEmittedAssistantMessageIds = new Set<string>();
      let runCancelled = false;
      // 追踪 text 和 tool_call 的交错顺序
      const contentParts: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCallId: string }> = [];
      let lastPartType: 'text' | 'tool_call' | null = null;

      const agentLoop = createAgentLoop(config, (event) => {
        // 附带 sessionId 确保前端会话隔离。
        // event.data 可能是对象或数组（如 todo_update 的 TodoItem[]），
        // 数组不能 spread 进对象，需要区分处理。
        const emitted = emitAgentEvent(event);
        if (!emitted) return;
        if (event.type === 'agent_cancelled') {
          runCancelled = true;
        }

        if (event.type === 'message' && event.data && typeof event.data === 'object') {
          const message = event.data as import('../../shared/contract').Message;
          if (message.id && message.role === 'assistant') {
            loopEmittedAssistantMessageIds.add(message.id);
          }
        }

        // 收集 message_delta / stream_chunk 中的文本
        if (event.type === 'message_delta' && event.data?.text) {
          if (event.data.path === 'content') {
            if (lastPartType !== 'text') {
              contentParts.push({ type: 'text', text: '' });
              lastPartType = 'text';
            }
            const lastPart = contentParts[contentParts.length - 1];
            if (lastPart?.type === 'text') lastPart.text += event.data.text;
            assistantText += event.data.text;
          } else if (event.data.path === 'reasoning') {
            assistantThinking += event.data.text;
          }
        }
        if (event.type === 'stream_chunk' && event.data?.content) {
          if (lastPartType !== 'text') {
            contentParts.push({ type: 'text', text: '' });
            lastPartType = 'text';
          }
          const lastPart = contentParts[contentParts.length - 1];
          if (lastPart?.type === 'text') lastPart.text += event.data.content;
          assistantText += event.data.content;
        }
        // 收集 reasoning/thinking
        if (event.type === 'stream_reasoning' && event.data?.content) {
          assistantThinking += event.data.content;
        }
        // 收集工具调用开始
        if (event.type === 'tool_call_start' && event.data) {
          const toolCallId = event.data.id || `tool-${assistantToolCalls.length}`;
          assistantToolCalls.push({
            id: toolCallId,
            name: event.data.name || 'unknown',
          });
          contentParts.push({ type: 'tool_call', toolCallId });
          lastPartType = 'tool_call';
        }
        // 收集工具调用结果 + 连续失败检测
        if (event.type === 'tool_call_end' && event.data) {
          const output = event.data.success
            ? String(event.data.output || '').substring(0, 500)
            : `Error: ${event.data.error || 'unknown'}`;
          toolResultMessages.push({
            id: `toolres-${Date.now()}-${toolResultMessages.length}`,
            role: 'tool',
            content: output,
            timestamp: Date.now(),
          });
          // 回填 result 到对应的 toolCall（前端渲染状态需要）
          const callId = event.data.toolCallId;
          if (callId) {
            const tc = assistantToolCalls.find(t => t.id === callId);
            if (tc) {
              tc.result = {
                success: !!event.data.success,
                output: event.data.success ? String(event.data.output || '').substring(0, 200) : undefined,
                error: event.data.success ? undefined : String(event.data.error || 'unknown'),
                metadata: event.data.metadata as Record<string, unknown> | undefined,
              };
            }
          }
          // 工具失败时通知前端
          if (!event.data.success) {
            consecutiveToolFailures++;
            if (consecutiveToolFailures >= 2) {
              emitSSE('tool_warning', {
                message: `工具连续 ${consecutiveToolFailures} 次失败: ${event.data.error || 'unknown'}`,
                level: 'warning',
                sessionId,
              });
            }
          } else {
            consecutiveToolFailures = 0;
          }
        }
      }, messages, sessionId, undefined, bridgeToolExecutor);

      // 存储当前 agentLoop 引用，供 cancel 使用
      activeAgentLoops.set(sessionId, agentLoop);
      if (clientDisconnected) {
        logger.warn(`[AgentRouter] Client already disconnected before run started; cancelling ${sessionId}`);
        await Promise.resolve(agentLoop.cancel('user'));
      }

      // 新会话时立即通知前端刷新列表（不等 agentLoop 完成）
      if (history.length === 0) {
        const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
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
            buildSessionTitle(prompt),
            { provider: runModelConfig.provider as ModelProvider, model: runModelConfig.model },
          );
          await persistMessageToDb(sm, db, sessionId, {
            id: msgId,
            role: 'user',
            content: enrichedPrompt,
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
          const title = buildSessionTitle(prompt);
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
            content: enrichedPrompt,
            timestamp: userMsg.timestamp,
            updated_at: Date.now(),
            source_device_id: 'web',
          });
          userMsgPrePersistedSupabase = true;
        }
      } catch (err) {
        logger.warn('Pre-persist user message to Supabase failed (continuing run):', (err as Error).message);
      }

      await agentLoop.run(prompt);

      // ── 缓存会话消息（维持多轮上下文）──
      // 无论 assistantText 是否为空都要缓存 userMsg，否则工具-only 轮次会丢失上下文
      const assistantMsgId = `msg-${Date.now()}-a`;
      const cached = [...(sessionMessages.get(sessionId) || []), userMsg];
      if (!runCancelled && (assistantText || assistantToolCalls.length > 0)) {
        // 只在有交错时才附带 contentParts（纯文本或纯工具调用无需）
        const hasInterleaving = contentParts.length > 1 || (contentParts.length === 1 && assistantToolCalls.length > 0 && assistantText);
        cached.push({
          id: assistantMsgId,
          role: 'assistant',
          content: assistantText,
          timestamp: Date.now(),
          toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
          thinking: assistantThinking || undefined,
          contentParts: hasInterleaving ? contentParts : undefined,
        });
        // 注意：toolResultMessages 不存入 sessionMessages，避免 role:'tool' 消息
        // 被传入 createAgentLoop 导致类型不匹配。工具结果只存到 DB/Supabase。
      }
      sessionMessages.set(sessionId, cached);

      // LRU 清理：超过上限时移除最旧的会话
      if (sessionMessages.size > SESSION_CACHE_MAX) {
        const oldestKey = sessionMessages.keys().next().value;
        if (oldestKey) sessionMessages.delete(oldestKey);
      }

      // ── 更新内存会话元数据 ──
      {
        const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
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
          const { getDatabase: ensureDb } = await import('../../main/services/core/databaseService');
          const dbForSession = ensureDb();
          if (!dbForSession.getSession(sessionId)) {
            dbForSession.createSessionWithId(sessionId, {
              title: prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt,
              modelConfig: runModelConfig,
            });
          }

          const sm = await tryGetSessionManager();
          const loopPersistedAssistant = await hasPersistedLoopAssistantMessage(
            sessionId,
            loopEmittedAssistantMessageIds,
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
                content: prompt,
                timestamp: userMsg.timestamp,
              } as import('../../shared/contract').Message);
            }
            if (!runCancelled && (assistantText || assistantToolCalls.length > 0) && !loopPersistedAssistant) {
              await sm.addMessageToSession(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: assistantText,
                timestamp: Date.now(),
                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                thinking: assistantThinking || undefined,
              } as import('../../shared/contract').Message);
            }
          } else {
            // SM 不可用时降级为直写 DB（session 已在上面 ensure 创建）
            const { getDatabase } = await import('../../main/services/core/databaseService');
            const db = getDatabase();
            if (!userMsgPrePersistedDb) {
              db.addMessage(sessionId, {
                id: msgId,
                role: 'user',
                content: prompt,
                timestamp: userMsg.timestamp,
              } as import('../../shared/contract').Message);
            }
            if (!runCancelled && (assistantText || assistantToolCalls.length > 0) && !loopPersistedAssistant) {
              db.addMessage(sessionId, {
                id: assistantMsgId,
                role: 'assistant',
                content: assistantText,
                timestamp: Date.now(),
                toolCalls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
                thinking: assistantThinking || undefined,
              } as import('../../shared/contract').Message);
            }
          }
          // 更新会话标题/时间戳
          const { getDatabase: getDb } = await import('../../main/services/core/databaseService');
          const db = getDb();
          if (history.length === 0) {
            const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
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
          const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
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
              content: prompt,
              timestamp: userMsg.timestamp,
              updated_at: Date.now(),
              source_device_id: 'web',
            });
          }
          // Insert assistant message
          if (!runCancelled && (assistantText || assistantToolCalls.length > 0)) {
            await sb.supabase.from('messages').insert({
              id: assistantMsgId,
              session_id: sessionId,
              user_id: sb.userId,
              role: 'assistant',
              content: assistantText,
              tool_calls: assistantToolCalls.length > 0 ? JSON.stringify(assistantToolCalls) : null,
              thinking: assistantThinking || null,
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

      const finalStatus: SessionStatus = runCancelled
        ? 'interrupted'
        : runHadTerminalError
          ? 'error'
          : 'completed';
      await updateRunSessionStatus(finalStatus);

      // session:updated 和 session:list-updated 已按运行状态广播

      // 发送 agent_complete（useAgent 依赖此事件清除处理状态）
      emitAgentEvent({ type: 'agent_complete', data: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (externalEngineFailureContext) {
        recordExternalEngineFailure({
          sessionId,
          message,
          context: externalEngineFailureContext,
        }, logger);
      }
      await updateRunSessionStatus('error');
      if (!clientDisconnected) {
        emitAgentEvent({
          type: 'error',
          data: {
            message,
          },
        });
      }
    } finally {
      runSettled = true;
      res.off('close', cancelForDisconnect);
      activeAgentLoops.delete(sessionId);
      agentSSEBatcher.destroy();
      // Telemetry: 结束会话追踪（写入聚合指标到 telemetry_sessions）
      try {
        const { getTelemetryCollector } = await import('../../main/telemetry');
        const collector = getTelemetryCollector();
        collector.endSession(sessionId);
      } catch { /* telemetry cleanup failure is non-fatal */ }
      if (canWriteSSE()) {
        res.end();
      }
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

  router.post('/interrupt', async (req: Request, res: Response) => {
    const rawBody: unknown = req.body;
    const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? rawBody as Record<string, unknown>
      : {};
    const content = typeof body.content === 'string'
      ? body.content
      : typeof body.prompt === 'string'
        ? body.prompt
        : '';
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
