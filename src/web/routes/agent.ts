import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ExecuteOptions } from '../../main/tools/toolExecutor';
import { isLocalTool, mapToolName } from '../../shared/localTools';
import { broadcastSSE, sendSSE } from '../helpers/sse';
import { formatError } from '../helpers/utils';
import {
  type CachedMessage,
  type CachedToolCall,
  type InMemorySession,
  sessionMessages,
  SESSION_CACHE_MAX,
  inMemorySessions,
  dbAvailable,
} from '../helpers/sessionCache';

// ── Local Tool Bridge: 待处理的本地工具调用 ──
// key = toolCallId, value = { resolve, reject, timer }
export interface PendingLocalToolCall {
  resolve: (result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AgentRouterDeps {
  activeAgentLoops: Map<string, { cancel(): void }>;
  pendingLocalToolCalls: Map<string, PendingLocalToolCall>;
  logger: { info: (msg: string, ...args: any[]) => void; warn: (msg: string, ...args: any[]) => void; error: (msg: string, ...args: any[]) => void };
  tryGetSessionManager: () => Promise<any>;
  getSupabaseForSession: () => Promise<{ supabase: any; userId: string } | null>;
}

const LOCAL_TOOL_TIMEOUT_MS = 120_000; // 2 分钟超时

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
    const { prompt, project, model, provider, generation } = req.body;

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
    const sessionId = req.body.sessionId || `web-session-${Date.now()}`;
    sendSSE(res, 'task_start', { taskId, prompt, sessionId });

    try {
      const { createCLIAgent } = await import('../../cli/adapter');
      const { createAgentLoop } = await import('../../cli/bootstrap');

      const agent = await createCLIAgent({
        project: project || process.cwd(),
        gen: generation,
        model,
        provider,
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
        };
        const envKey = providerEnvMap[config.modelConfig.provider];
        if (envKey && process.env[envKey]) {
          config.modelConfig.apiKey = process.env[envKey];
        }
      }

      // ── 构建消息历史（多轮上下文）──
      // 将附件文本数据拼接到 prompt 中，使 Agent 能看到附件内容
      let enrichedPrompt = prompt;
      const userContent: unknown[] = [];
      if (req.body.attachments?.length) {
        const textParts: string[] = [];
        for (const att of req.body.attachments) {
          if (att.category === 'image' && att.data) {
            userContent.push({
              type: 'image',
              source: { type: 'base64', media_type: att.mimeType || 'image/png', data: att.data },
            });
          } else if (att.data && typeof att.data === 'string') {
            // 非图片附件：将文本数据注入到 prompt 中
            const label = att.name || att.category || 'attachment';
            textParts.push(`\n\n<attachment name="${label}" category="${att.category || 'file'}">\n${att.data}\n</attachment>`);
          }
        }
        if (textParts.length > 0) {
          enrichedPrompt = prompt + textParts.join('');
        }
      }
      userContent.unshift({ type: 'text', text: enrichedPrompt });

      const msgId = `msg-${Date.now()}`;
      const userMsg: CachedMessage = {
        id: msgId,
        role: 'user' as const,
        content: enrichedPrompt,
        timestamp: Date.now(),
      };

      // 加载历史消息 + 当前用户消息
      // 只传 role/content/timestamp 给 agentLoop，toolCalls/thinking 仅用于持久化
      const history = (sessionMessages.get(sessionId) || []).map(({ id, role, content, timestamp }) => ({
        id, role: role as 'user' | 'assistant', content, timestamp,
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

            sendSSE(res, 'tool_call_local', {
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
      // 追踪 text 和 tool_call 的交错顺序
      const contentParts: Array<{ type: 'text'; text: string } | { type: 'tool_call'; toolCallId: string }> = [];
      let lastPartType: 'text' | 'tool_call' | null = null;

      const agentLoop = createAgentLoop(config, (event) => {
        // 附带 sessionId 确保前端会话隔离。
        // event.data 可能是对象或数组（如 todo_update 的 TodoItem[]），
        // 数组不能 spread 进对象，需要区分处理。
        const eventData = Array.isArray(event.data)
          ? { items: event.data, sessionId }
          : event.data ? { ...event.data, sessionId } : { sessionId };
        sendSSE(res, event.type, eventData);

        // 收集 stream_chunk 中的文本
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
              sendSSE(res, 'error', {
                data: { message: `工具连续 ${consecutiveToolFailures} 次失败: ${event.data.error || 'unknown'}`, level: 'warning' },
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

      // 新会话时立即通知前端刷新列表（不等 agentLoop 完成）
      if (history.length === 0) {
        const title = prompt.length > 30 ? prompt.substring(0, 30) + '...' : prompt;
        broadcastSSE('session:updated', { sessionId, updates: { title } });
        broadcastSSE('session:list-updated', undefined);
      }

      await agentLoop.run(prompt);

      // ── 缓存会话消息（维持多轮上下文）──
      // 无论 assistantText 是否为空都要缓存 userMsg，否则工具-only 轮次会丢失上下文
      const assistantMsgId = `msg-${Date.now()}-a`;
      const cached = [...(sessionMessages.get(sessionId) || []), userMsg];
      if (assistantText || assistantToolCalls.length > 0) {
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
          if (sm) {
            // 通过 SM 写入，同时更新 DB 和 sessionCache
            await sm.addMessageToSession(sessionId, {
              id: msgId,
              role: 'user',
              content: prompt,
              timestamp: userMsg.timestamp,
            } as import('../../shared/contract').Message);
            if (assistantText || assistantToolCalls.length > 0) {
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
            db.addMessage(sessionId, {
              id: msgId,
              role: 'user',
              content: prompt,
              timestamp: userMsg.timestamp,
            } as import('../../shared/contract').Message);
            if (assistantText || assistantToolCalls.length > 0) {
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
          // Insert user message
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
          // Insert assistant message
          if (assistantText || assistantToolCalls.length > 0) {
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

      // session:updated 和 session:list-updated 已在 agentLoop.run() 之前广播

      // 发送 agent_complete（useAgent 依赖此事件清除处理状态）
      sendSSE(res, 'agent_complete', { sessionId });
    } catch (error) {
      sendSSE(res, 'error', {
        message: error instanceof Error ? error.message : 'Unknown error',
        sessionId,
      });
    } finally {
      activeAgentLoops.delete(sessionId);
      // Telemetry: 结束会话追踪（写入聚合指标到 telemetry_sessions）
      try {
        const { getTelemetryCollector } = await import('../../main/telemetry');
        const collector = getTelemetryCollector();
        collector.endSession(sessionId);
      } catch { /* telemetry cleanup failure is non-fatal */ }
      res.end();
    }
  });

  // ── Cancel ─────────────────────────────────────────────────────────
  router.post('/cancel', (req: Request, res: Response) => {
    const sessionId = req.body?.sessionId;
    if (sessionId && activeAgentLoops.has(sessionId)) {
      activeAgentLoops.get(sessionId)!.cancel();
      activeAgentLoops.delete(sessionId);
      res.json({ message: 'Cancelled', sessionId });
    } else if (activeAgentLoops.size > 0) {
      // 没指定 sessionId 时取消最后一个
      const lastKey = [...activeAgentLoops.keys()].pop()!;
      activeAgentLoops.get(lastKey)!.cancel();
      activeAgentLoops.delete(lastKey);
      res.json({ message: 'Cancelled', sessionId: lastKey });
    } else {
      res.json({ message: 'No active agent to cancel' });
    }
  });

  // ── Tool Result (Local Bridge 前端回传工具执行结果) ────────────────
  router.post('/tool-result', (req: Request, res: Response) => {
    const { toolCallId, success, output, error, metadata } = req.body;
    if (!toolCallId) {
      res.status(400).json({ error: 'Missing toolCallId' });
      return;
    }
    const pending = pendingLocalToolCalls.get(toolCallId);
    if (!pending) {
      res.status(404).json({ error: `No pending tool call: ${toolCallId}` });
      return;
    }
    clearTimeout(pending.timer);
    pendingLocalToolCalls.delete(toolCallId);
    pending.resolve({ success: !!success, output, error, metadata });
    res.json({ message: 'Tool result received', toolCallId });
  });

  return router;
}
