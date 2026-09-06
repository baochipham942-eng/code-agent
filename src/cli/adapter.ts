// ============================================================================
// CLI Adapter - 适配 AgentLoop 到 CLI
// ============================================================================

import {
  createAgentLoop,
  buildCLIConfig,
  initializeCLIServices,
  getSessionManager,
  getConfigService,
  startCLIDurableRun,
  terminalCLIDurableRun,
  whenCLIMcpReady,
} from './bootstrap';
import { terminalOutput, jsonOutput } from './output';
import { addSwarmEventListener } from '../host/ipc/swarm.ipc';
import fs from 'fs';
import path from 'path';
import type { CLIConfig, CLIRunResult, CLIGlobalOptions } from './types';
import type { Message, AgentEvent, PRLink, ModelConfig } from '../shared/contract';
import { getCompactionCommandMessages } from '../shared/i18n/compactionCommand';
import { getModelMaxOutputTokens } from '../shared/constants';
import { createLogger } from '../host/services/infra/logger';
import { getSessionSkillService } from '../host/services/skills/sessionSkillService';
import { MetricsCollector, type SessionMetrics } from '../host/agent/metricsCollector';
import { StatusFileWriter } from './utils/statusFile';
import { retryEvents } from '../host/model/providers/retryStrategy';
import { getAgentDispatchInfo } from './agentDispatch';
import { createRunContext, type RunContext, type RunHandle } from '../host/runtime/runContext';
import { createRunTraceContext, withRunTraceContext } from '../host/telemetry/runTraceContext';
import { generateMessageId } from '../shared/utils/id';
import { readPersistedExpertThread } from '../shared/contract/expertThread';
import { resolveExplicitAgentOverride } from '../host/agent/explicitAgentOverride';

export { getAgentDispatchInfo, isAgentDispatchToolName } from './agentDispatch';

const logger = createLogger('CLI-Adapter');

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Subscribe to retry events for CLI visibility
retryEvents.on('retry', (info: { provider: string; attempt: number; maxRetries: number; delay: number; error: string }) => {
  terminalOutput.retrying(info.provider, info.attempt, info.maxRetries, info.delay);
});

/**
 * CLI Agent 运行器
 */
export class CLIAgent {
  private config: CLIConfig;
  private messages: Message[] = [];
  private isRunning: boolean = false;
  private isCompacting = false;
  private currentResult: CLIRunResult | null = null;
  private resolveRun: ((result: CLIRunResult) => void) | null = null;
  private startTime: number = 0;
  private toolsUsed: string[] = [];
  private lastContent: string = '';
  private sessionId: string | null = null;
  private injectedContext: string = '';
  private prLink: PRLink | null = null;
  private unsubscribeSwarm: (() => void) | null = null;
  /** Track spawn_agent tool call IDs for agent_dispatch/agent_result mapping */
  private pendingAgentCalls: Map<string, { agent: string; task: string }> = new Map();
  /** Track tool call IDs to tool names for tool_result events */
  private toolCallNames: Map<string, string> = new Map();
  /** Track turn timing for model_call events */
  private turnStartTime: number = 0;
  /** Per-run metrics collector (active when --metrics or --status-file is set) */
  private metricsCollector: MetricsCollector | null = null;
  /** Per-run status file heartbeat writer (active when --status-file is set) */
  private statusFileWriter: StatusFileWriter | null = null;
  /** Current AgentLoop instance (for cancel/interrupt/hooks) */
  private currentAgentLoop: { cancel(): void; interrupt(msg: string): void; getHookManager?(): unknown } | null = null;
  /** Last completed AgentLoop hook manager, kept so /hooks works between turns. */
  private lastHookManager: unknown = null;
  /** Real token usage from stream_usage events */
  private realInputTokens: number = 0;
  private realOutputTokens: number = 0;
  /** Last run-level error event, used to keep agent_complete from masking failures. */
  private runErrorMessage: string | null = null;
  /** Error class of a rejected agentLoop.run(), reported in the status file terminal state. */
  private runErrorClass: string | null = null;
  /** Most recently started turn; a new context is created for every run(). */
  private lastRunContext: RunContext | null = null;
  private currentDurableRun: RunHandle | null = null;

  private systemPrompt: string | undefined;

  /** External event observer (TUI status bar updates) */
  private eventObserver: ((event: AgentEvent) => void) | null = null;

  constructor(options: Partial<CLIGlobalOptions> = {}) {
    this.config = buildCLIConfig(options);
    this.systemPrompt = options.systemPrompt;
  }

  /**
   * 初始化会话
   */
  async initSession(): Promise<string> {
    const sessionManager = getSessionManager();
    const session = await sessionManager.getOrCreateCurrentSession({
      modelConfig: this.config.modelConfig,
      workingDirectory: this.config.workingDirectory,
    });
    this.sessionId = session.id;

    // 自动挂载默认 skills（含 builtin/data-cleaning）
    const skillService = getSessionSkillService();
    skillService.autoMountDefaultSkills(session.id);

    return session.id;
  }

  /**
   * 获取当前配置
   */
  getConfig(): CLIConfig {
    return this.config;
  }

  /**
   * 切换模型（下次 run 生效）
   * 自动从 env 获取对应 provider 的 API Key
   */
  setModel(provider: string, model: string, apiKey?: string): void {
    // Auto-resolve API key for the new provider
    let resolvedKey = apiKey;
    if (!resolvedKey) {
      try {
        // provider 是 user 输入的字符串，cast 成 ModelProvider；
        // 不在联合类型里时 main getApiKey 通过 envKeyMap 拿不到 key 直接返回 undefined
        resolvedKey = getConfigService().getApiKey(provider as ModelConfig['provider']);
      } catch {
        // Config service not ready, keep existing key
      }
    }

    this.config.modelConfig = {
      ...this.config.modelConfig,
      provider: provider as ModelConfig['provider'],
      model,
      maxTokens: getModelMaxOutputTokens(model),
      ...(resolvedKey ? { apiKey: resolvedKey } : {}),
    };
  }

  /**
   * 运行单次任务
   */
  async run(prompt: string): Promise<CLIRunResult> {
    if (this.isRunning || this.isCompacting) {
      return {
        success: false,
        error: this.isCompacting
          ? getCompactionCommandMessages(getConfigService().getSettings().ui.language).compacting
          : 'Agent is already running',
      };
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.toolsUsed = [];
    this.lastContent = '';
    this.pendingAgentCalls.clear();
    this.toolCallNames.clear();
    this.turnStartTime = 0;
    this.runErrorMessage = null;
    this.runErrorClass = null;

    // 确保有会话
    if (!this.sessionId) {
      await this.initSession();
    }
    if (!this.sessionId) {
      throw new Error('CLI session initialization did not produce a sessionId');
    }
    const persistedSession = await getSessionManager().getSession(this.sessionId, 0).catch(() => null);
    const persistedExpertRoleId = readPersistedExpertThread(persistedSession?.metadata)?.roleId;
    const persistedExpertOverride = !this.config.agentOverride && persistedExpertRoleId
      ? resolveExplicitAgentOverride(persistedExpertRoleId)
      : null;
    if (persistedExpertRoleId && !this.config.agentOverride && !persistedExpertOverride) {
      logger.warn('Persisted expert thread role is unavailable; using the default agent', {
        sessionId: this.sessionId,
        roleId: persistedExpertRoleId,
      });
    }
    const runConfig: CLIConfig = {
      ...this.config,
      // neo CLI 发起 = 脚本/无头；界面会话走 web /api/run，那条路不带这个标记。
      originKind: 'headless',
      ...(persistedExpertOverride
        ? {
            agentOverride: persistedExpertOverride,
            requestedAgentId: persistedExpertRoleId,
          }
        : {}),
    };
    // MCP 就绪门：init 与首屏并行（云端 server HTTP 握手可达数秒），
    // 首个 run 在这里等它完成，保证工具表完整；之后为已解决 promise 零成本。
    await whenCLIMcpReady();

    const runInput = {
      sessionId: this.sessionId,
      workspace: runConfig.workingDirectory,
    };
    const durableRun = await startCLIDurableRun(runInput);
    const runContext = durableRun?.context ?? createRunContext(runInput);
    this.currentDurableRun = durableRun;
    this.lastRunContext = runContext;
    // 日志关联（缺口修复）：run 级 correlation context 在 adapter 边界就建好，
    // 整个 run 生命周期（含 agentLoop 内外的 adapter 日志、fire-and-forget 回调）
    // 写文件日志时自动带 sessionId/traceId，可用 `grep sessionId` 收敛一次会话。
    // AsyncLocalStorage 按异步链隔离，并发 run/子代理各带各的上下文，不串味。
    const runTraceContext = durableRun?.traceContext ?? createRunTraceContext({
      runId: runContext.runId,
      sessionId: runContext.sessionId,
      attempt: 1,
      ownerEpoch: 0,
      engine: 'native',
      workspace: runContext.workspace,
      processInstanceId: `cli-${process.pid}`,
    });

    // Inject system prompt if provided (before user message)
    if (this.systemPrompt && this.messages.length === 0) {
      this.injectContext(this.systemPrompt);
    }

    // 添加用户消息
    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    // 保存消息到会话
    try {
      const sessionManager = getSessionManager();
      await sessionManager.addMessage(userMessage);
    } catch (error) {
      logger.debug('Failed to save user message to session', { error: (error as Error).message });
    }

    // 注册 Swarm 事件监听器（CLI 模式下将 swarm 事件路由到终端/JSON 输出）
    if (!this.unsubscribeSwarm) {
      this.unsubscribeSwarm = addSwarmEventListener((event) => {
        if (this.config.outputFormat === 'stream-json') {
          this.writeStreamJson('swarm', event);
        } else if (this.config.outputFormat === 'json') {
          jsonOutput.handleSwarmEvent(event);
        } else {
          terminalOutput.handleSwarmEvent(event);
        }
      });
    }

    // Create MetricsCollector if --metrics or --status-file is configured
    // （--status-file 的终态指标汇总复用同一份采集数据）
    if (this.config.metricsPath || this.config.statusFilePath) {
      this.metricsCollector = new MetricsCollector(this.sessionId || `cli-${Date.now()}`);
    } else {
      this.metricsCollector = null;
    }

    // Create status file heartbeat writer if --status-file is configured
    if (this.config.statusFilePath) {
      // token 用量每次写快照时从本 run 的 MetricsCollector 实时拉取（与终态 metrics 汇总同源）；
      // 部分 provider 同时发 stream_usage 与 model_response，直接用 realInputTokens 会双计。
      const liveCollector = this.metricsCollector;
      this.statusFileWriter = new StatusFileWriter(this.config.statusFilePath, this.sessionId, {
        startedAt: this.startTime,
        ...(liveCollector
          ? {
              tokensProvider: () => {
                const m = liveCollector.getMetrics();
                return { input: m.inputTokens, output: m.outputTokens };
              },
            }
          : {}),
      });
      this.statusFileWriter.start();
    } else {
      this.statusFileWriter = null;
    }

    // Reset real token counters
    this.realInputTokens = 0;
    this.realOutputTokens = 0;

    // 创建 AgentLoop（传入真实 sessionId + optional MetricsCollector）
    const agentLoop = createAgentLoop(
      runConfig,
      this.handleEvent.bind(this),
      this.messages,
      this.sessionId || undefined,
      this.metricsCollector || undefined,
      undefined,
      runContext,
      runTraceContext,
    );
    this.currentAgentLoop = agentLoop;
    this.lastHookManager = agentLoop.getHookManager?.() ?? this.lastHookManager;

    return new Promise<CLIRunResult>((resolve) => {
      this.resolveRun = resolve;

      // 运行 Agent（整个生命周期都在 run correlation context 内，文件日志自动带 sessionId）
      withRunTraceContext(runTraceContext, () => {
        agentLoop.run(prompt).catch((error: unknown) => {
          logger.error('Agent run error', error);
          this.runErrorClass = error instanceof Error ? error.name : null;
          // 失败收口不能抹掉本轮已产生的成果：模型中途瞬断（如网关 5xx 重试耗尽）时，
          // 前面成功的工具结果/已生成内容仍属于这次 run 的记录，原样带出去。
          void this.finishRun({
            success: false,
            error: getErrorMessage(error),
            output: this.lastContent || this.getLastAssistantMessage()?.content,
            toolsUsed: [...new Set(this.toolsUsed)],
            duration: Date.now() - this.startTime,
          });
        });
      });
    });
  }

  /**
   * Write a JSONL line for stream-json format
   */
  private writeStreamJson(type: string, content: unknown): void {
    const line = JSON.stringify({ type, content, ts: Date.now() });
    process.stdout.write(line + '\n');
  }

  /**
   * 处理 Agent 事件
   */
  private handleEvent(event: AgentEvent): void {
    // Notify external observer (TUI status bar)
    this.eventObserver?.(event);
    // Status file heartbeat: hook the same event stream (ticker-based writes, not per-event)
    if (this.statusFileWriter) {
      this.statusFileWriter.markRunning();
      if (event.type === 'turn_start') {
        this.statusFileWriter.onTurnStart();
      } else if (event.type === 'tool_call_start' && event.data?.name) {
        this.statusFileWriter.onToolStart(event.data.name);
      }
    }
    // stream-json: write JSONL lines for each event (JSONL protocol)
    if (this.config.outputFormat === 'stream-json') {
      if (event.type === 'stream_chunk' && event.data?.content) {
        this.writeStreamJson('text', event.data.content);
      } else if (event.type === 'tool_call_start') {
        const data = event.data as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
        const toolName = data?.name || 'unknown';
        const toolArgs = data?.arguments || {};
        const toolCallId = data?.id || `unknown-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        this.toolCallNames.set(toolCallId, toolName);
        const dispatch = getAgentDispatchInfo(toolName, toolArgs);
        if (dispatch) {
          // Emit agent_dispatch for sub-agent spawning
          this.pendingAgentCalls.set(toolCallId, dispatch);
          this.writeStreamJson('agent_dispatch', dispatch);
        } else {
          this.writeStreamJson('tool_start', { name: toolName, args: toolArgs });
        }
      } else if (event.type === 'tool_call_end') {
        const data = event.data as { toolCallId?: string; output?: string; success?: boolean } | undefined;
        const toolCallId = data?.toolCallId || '';
        const pending = this.pendingAgentCalls.get(toolCallId);
        if (pending) {
          // Emit agent_result for completed sub-agent
          this.pendingAgentCalls.delete(toolCallId);
          this.writeStreamJson('agent_result', {
            agent: pending.agent,
            result: data?.output?.substring(0, 2000) || '',
            success: data?.success,
          });
        } else {
          const name = this.toolCallNames.get(toolCallId) || 'unknown';
          this.toolCallNames.delete(toolCallId);
          this.writeStreamJson('tool_result', { name, result: { output: data?.output } });
        }
      } else if (event.type === 'turn_start') {
        this.turnStartTime = Date.now();
        this.writeStreamJson('turn_start', {});
      } else if (event.type === 'model_response') {
        // model_response fires after inference, BEFORE tool execution
        // Contains model, duration, toolCalls — the logical "decision" event
        const d = event.data as { model?: string; duration?: number; toolCalls?: string[]; inputTokens?: number; outputTokens?: number } | undefined;
        this.writeStreamJson('model_call', {
          model: d?.model || this.config.modelConfig.model,
          duration: d?.duration ? `${(d.duration / 1000).toFixed(1)}s` : undefined,
          toolCalls: d?.toolCalls || [],
          inputTokens: d?.inputTokens,
          outputTokens: d?.outputTokens,
        });
      } else if (event.type === 'turn_end') {
        // turn_end is a boundary marker — server uses it for context accumulation
        this.writeStreamJson('turn_end', {});
      } else if (event.type === 'subagent_activity') {
        this.writeStreamJson('subagent_activity', event.data);
      } else if (event.type === 'subagent_run_end') {
        this.writeStreamJson('subagent_run_end', event.data);
      } else if (event.type === 'error') {
        this.writeStreamJson('error', event.data?.message);
      } else if (event.type === 'message' && event.data?.role === 'assistant' && event.data?.content) {
        // Emit full text content (in case stream_chunk was not used)
        if (!this.lastContent) {
          this.writeStreamJson('text', event.data.content);
        }
      } else if (event.type === 'agent_complete') {
        this.writeStreamJson('done', null);
      }
    } else if (this.config.outputFormat === 'json') {
      // 根据输出格式分发事件
      jsonOutput.handleEvent(event);
    } else if (!this.eventObserver) {
      // Ink TUI 拥有屏幕时（eventObserver 已注册）不能再走 legacy 线性渲染——
      // 它直接写 stdout 的进度行/原文/状态横幅会被 Ink 下一帧擦掉（左下角频闪
      // 「分析请求中」的真凶），并在 scrollback 留下未渲染的 markdown 原文
      terminalOutput.handleEvent(event);
    }

    // 记录工具使用
    if (event.type === 'tool_call_start' && event.data?.name) {
      this.toolsUsed.push(event.data.name);
    }

    // 记录最后的内容
    if (event.type === 'stream_chunk' && event.data?.content) {
      this.lastContent += event.data.content;
    }

    // 累计真实 token 用量
    if (event.type === 'stream_usage') {
      const usage = event.data as { inputTokens?: number; outputTokens?: number };
      if (usage.inputTokens) this.realInputTokens += usage.inputTokens;
      if (usage.outputTokens) this.realOutputTokens += usage.outputTokens;
    }
    if (event.type === 'model_response') {
      const resp = event.data as { inputTokens?: number; outputTokens?: number };
      if (resp.inputTokens) this.realInputTokens += resp.inputTokens;
      if (resp.outputTokens) this.realOutputTokens += resp.outputTokens;
    }

    if (event.type === 'message' && event.data?.role === 'assistant') {
      // 注意：不再手动 push 到 this.messages，因为 agentLoop.addAndPersistMessage()
      // 已经往共享的 messages 数组 push 了。重复 push 会导致结构化 tool_calls 协议错误
      // （两个 assistant 消息 back-to-back，API 400: tool_call_ids without response）
    }

    // 错误处理：记录到 run 结果，等待 agent_complete 统一收口
    if (event.type === 'error') {
      this.runErrorMessage = event.data?.message || 'Agent run failed';
      logger.warn('Agent error event', { message: this.runErrorMessage });
    }

    // MetricsCollector: track context compression and errors
    if (this.metricsCollector) {
      if (event.type === 'context_compressed') {
        this.metricsCollector.recordCompaction();
      }
      if (event.type === 'error') {
        const errData = event.data as { message?: string; code?: string } | undefined;
        this.metricsCollector.recordError(
          errData?.code || 'agent_error',
          errData?.message || 'unknown error'
        );
      }
    }

    // Agent 完成
    if (event.type === 'agent_complete') {
      void this.finishRun({
        success: !this.runErrorMessage,
        output: this.lastContent || this.getLastAssistantMessage()?.content,
        ...(this.runErrorMessage ? { error: this.runErrorMessage } : {}),
        toolsUsed: [...new Set(this.toolsUsed)],
        duration: Date.now() - this.startTime,
      });
    }
  }

  /**
   * 完成运行
   */
  private async finishRun(result: CLIRunResult): Promise<void> {
    const resolveRun = this.resolveRun;
    if (!resolveRun) return;
    this.resolveRun = null;
    this.isRunning = false;
    this.currentResult = result;
    this.currentAgentLoop = null;
    const durableRun = this.currentDurableRun;
    this.currentDurableRun = null;

    // Write metrics JSON if collector is active
    const metricsCollector = this.metricsCollector;
    let metricsSummary: SessionMetrics | undefined;
    if (metricsCollector && this.config.metricsPath) {
      try {
        const metricsPath = path.resolve(this.config.metricsPath);
        const dir = path.dirname(metricsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const metricsJson = metricsCollector.toJSON();
        fs.writeFileSync(metricsPath, metricsJson, 'utf-8');
        result.metricsPath = metricsPath;
        logger.info(`Metrics written to ${metricsPath}`);
      } catch (error) {
        logger.warn('Failed to write metrics file', { error: getErrorMessage(error) });
      }
    }
    if (metricsCollector) {
      metricsSummary = metricsCollector.finalize();
      this.metricsCollector = null;
    }

    // Write terminal status snapshot if status file writer is active
    if (this.statusFileWriter) {
      this.statusFileWriter.finish({
        success: result.success,
        ...(result.success
          ? {}
          : {
              error: {
                message: result.error || 'unknown error',
                ...(this.runErrorClass ? { class: this.runErrorClass } : {}),
              },
            }),
        ...(metricsSummary ? { metrics: metricsSummary } : {}),
      });
      this.statusFileWriter = null;
      this.runErrorClass = null;
    }

    // 取消 Swarm 事件监听
    if (this.unsubscribeSwarm) {
      this.unsubscribeSwarm();
      this.unsubscribeSwarm = null;
    }

    if (durableRun) {
      try {
        await terminalCLIDurableRun(durableRun, result.success);
      } catch (error) {
        logger.warn('Failed to terminal CLI Durable Run', { error: getErrorMessage(error) });
      }
    }
    resolveRun(result);
  }

  /**
   * 获取最后一条助手消息
   */
  private getLastAssistantMessage(): Message | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === 'assistant') {
        return this.messages[i];
      }
    }
    return undefined;
  }

  /**
   * 清空对话历史
   */
  clearHistory(): void {
    this.messages = [];
    this.sessionId = null;
  }

  /**
   * 获取对话历史
   */
  getHistory(): Message[] {
    return [...this.messages];
  }

  /** 手动压缩与自动压缩共用摘要服务，写回后下一轮直接使用压缩后的历史。 */
  async compactHistory(focusText?: string): Promise<Pick<
    import('../host/context/compactionService').CompactionServiceResult,
    'success' | 'reason' | 'beforeTokens' | 'afterTokens' | 'savedTokens'
  >> {
    const { estimateTokens } = await import('../host/context/tokenEstimator');
    const beforeTokens = this.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const unchanged = (reason: string) => ({
      success: false, reason, beforeTokens, afterTokens: beforeTokens, savedTokens: 0,
    });
    if (this.isCompacting) return unchanged('compaction_active');
    if (this.isRunning) return unchanged('run_active');
    const sessionId = this.sessionId;
    if (!sessionId) return unchanged('session_unavailable');
    const history = this.messages;
    const snapshot = [...history];
    const historyChanged = () => this.sessionId !== sessionId
      || this.messages !== history || history.length !== snapshot.length;
    this.isCompacting = true;
    try {
      // replaceMessages replaces the entire projection, so never compact only the loaded window.
      const session = await getSessionManager().getSession(sessionId, Number.MAX_SAFE_INTEGER);
      if (!session) return unchanged('session_unavailable');
      if (historyChanged()) return unchanged('history_changed');
      // injectContext (and an unpersisted local message) can exist only in memory.
      // Keep those entries in their live order, anchored before the next persisted ID.
      const messages = [...session.messages];
      let insertionIndex = messages.length;
      for (let index = snapshot.length - 1; index >= 0; index--) {
        const message = snapshot[index];
        const persistedIndex = messages.findIndex(({ id }) => id === message.id);
        if (persistedIndex >= 0) insertionIndex = persistedIndex;
        else messages.splice(insertionIndex, 0, message);
      }
      const { compactMessagesWithSummary } = await import('../host/context/compactionService');
      const settings = getConfigService().getSettings();
      const result = await compactMessagesWithSummary({
        sessionId,
        source: 'manual_current',
        messages,
        preserveRecentCount: settings.contextCompression?.preserveRecentCount,
        systemPrompt: this.systemPrompt,
        modelConfig: this.config.modelConfig,
        hookManager: this.getHookManager() as import('../host/context/compactionHooks').CompactionHookManagerLike | undefined,
        skipAudit: settings.contextCompression?.auditEnabled === false,
        focusText,
      });
      const outcome = {
        success: result.success, reason: result.reason,
        beforeTokens: result.beforeTokens, afterTokens: result.afterTokens, savedTokens: result.savedTokens,
      };
      if (!result.success || !result.newMessages) return outcome;
      if (historyChanged()) return unchanged('history_changed');
      await getSessionManager().replaceMessages(sessionId, result.newMessages);
      // The target session has committed successfully, even if the user switched away.
      // Retain any context injected while persistence was awaiting completion.
      if (this.sessionId === sessionId && this.messages === history) {
        this.messages = [...result.newMessages, ...history.slice(snapshot.length)];
      }
      return outcome;
    } finally {
      this.isCompacting = false;
    }
  }

  /**
   * 是否正在运行
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * 取消当前运行（ESC 中断）
   */
  cancel(): void {
    if (this.isRunning && this.currentAgentLoop) {
      this.currentAgentLoop.cancel();
    }
  }

  /**
   * 获取真实 token 用量
   */
  getTokenUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.realInputTokens, outputTokens: this.realOutputTokens };
  }

  /**
   * 获取成本信息（供 /cost、/status 命令使用）
   */
  getCostInfo(): { inputTokens: number; outputTokens: number; model: string; provider: string } {
    return {
      inputTokens: this.realInputTokens,
      outputTokens: this.realOutputTokens,
      model: this.config.modelConfig.model,
      provider: this.config.modelConfig.provider,
    };
  }

  /**
   * 获取 HookManager（供 /hooks 命令使用）
   */
  getHookManager(): unknown {
    return this.currentAgentLoop?.getHookManager?.() ?? this.lastHookManager;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * 获取当前会话标题（Ink TUI 终端标签标题用）。首条用户消息后会由 quick model
   * 自动改名（SessionManager.maybeUpdateTitle），因此调用方应在 turn 边界重取。
   */
  async getSessionTitle(): Promise<string | null> {
    if (!this.sessionId) return null;
    try {
      const session = await getSessionManager().getSession(this.sessionId, 0);
      return session?.title ?? null;
    } catch {
      return null;
    }
  }

  getLastRunContext(): RunContext | null {
    return this.lastRunContext;
  }

  /**
   * 恢复会话
   */
  async restoreSession(sessionId: string): Promise<boolean> {
    try {
      const sessionManager = getSessionManager();
      const session = await sessionManager.restoreSession(sessionId);
      if (session) {
        this.sessionId = session.id;
        this.messages = session.messages;
        // 恢复 PR 关联信息
        if (session.prLink) {
          this.prLink = session.prLink;
        }
        return true;
      }
    } catch (error) {
      logger.error('Failed to restore session', { error, sessionId });
    }
    return false;
  }

  /**
   * 注入上下文（会被添加到系统提示中）
   */
  injectContext(context: string): void {
    this.injectedContext = context;
    // 将上下文作为系统消息添加到历史
    if (context) {
      const systemMessage: Message = {
        id: generateMessageId(),
        role: 'system',
        content: context,
        timestamp: Date.now(),
      };
      this.messages.push(systemMessage);
    }
  }

  /**
   * 设置 PR 关联信息
   */
  setPRLink(link: PRLink): void {
    this.prLink = link;
    // 更新会话的 PR 关联
    if (this.sessionId) {
      try {
        const sessionManager = getSessionManager();
        sessionManager.updateSession(this.sessionId, { prLink: link }).catch((error: unknown) => {
          logger.warn('Failed to update session with PR link', { error });
        });
      } catch (error) {
        logger.warn('Failed to get session manager for PR link update', { error });
      }
    }
  }

  /**
   * Set an external event observer (for TUI status bar updates)
   */
  setEventObserver(observer: (event: AgentEvent) => void): void {
    this.eventObserver = observer;
  }

  /**
   * 获取 PR 关联信息
   */
  getPRLink(): PRLink | null {
    return this.prLink;
  }
}

/**
 * 创建 CLI Agent 实例
 */
export async function createCLIAgent(options: Partial<CLIGlobalOptions> = {}): Promise<CLIAgent> {
  await initializeCLIServices();
  return new CLIAgent(options);
}
