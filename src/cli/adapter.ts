// ============================================================================
// CLI Adapter - 适配 AgentLoop 到 CLI
// ============================================================================

import { createAgentLoop, buildCLIConfig, initializeCLIServices, cleanup, getSessionManager, syncCLIWorkingDirectory, getConfigService } from './bootstrap';
import { terminalOutput, jsonOutput } from './output';
import { addSwarmEventListener } from '../main/ipc/swarm.ipc';
import type { CLIConfig, CLIRunResult, CLIGlobalOptions } from './types';
import type { Message, AgentEvent, PRLink, ModelConfig } from '../shared/types';
import { getModelMaxOutputTokens } from '../shared/constants';
import { createLogger } from '../main/services/infra/logger';
import { getSessionSkillService } from '../main/services/skills/sessionSkillService';
import { MetricsCollector } from '../main/agent/metricsCollector';
import { retryEvents } from '../main/model/providers/retryStrategy';

const logger = createLogger('CLI-Adapter');

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
  /** Per-run metrics collector (active when --metrics is set) */
  private metricsCollector: MetricsCollector | null = null;
  /** Current AgentLoop instance (for cancel/interrupt) */
  private currentAgentLoop: { cancel(): void; interrupt(msg: string): void } | null = null;
  /** Real token usage from stream_usage events */
  private realInputTokens: number = 0;
  private realOutputTokens: number = 0;

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
      generationId: this.config.generationId as string,
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
        resolvedKey = getConfigService().getApiKey(provider);
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
    if (this.isRunning) {
      return {
        success: false,
        error: 'Agent is already running',
      };
    }

    this.isRunning = true;
    this.startTime = Date.now();
    this.toolsUsed = [];
    this.lastContent = '';
    this.pendingAgentCalls.clear();
    this.toolCallNames.clear();
    this.turnStartTime = 0;

    // 确保有会话
    if (!this.sessionId) {
      await this.initSession();
    }

    // Inject system prompt if provided (before user message)
    if (this.systemPrompt && this.messages.length === 0) {
      this.injectContext(this.systemPrompt);
    }

    // 添加用户消息
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
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

    // Create MetricsCollector if --metrics is configured
    if (this.config.metricsPath) {
      this.metricsCollector = new MetricsCollector(this.sessionId || `cli-${Date.now()}`);
    } else {
      this.metricsCollector = null;
    }

    // Reset real token counters
    this.realInputTokens = 0;
    this.realOutputTokens = 0;

    // 创建 AgentLoop（传入真实 sessionId + optional MetricsCollector）
    const agentLoop = createAgentLoop(
      this.config,
      this.handleEvent.bind(this),
      this.messages,
      this.sessionId || undefined,
      this.metricsCollector || undefined
    );
    this.currentAgentLoop = agentLoop;

    return new Promise<CLIRunResult>((resolve) => {
      this.resolveRun = resolve;

      // 运行 Agent
      agentLoop.run(prompt).catch((error) => {
        logger.error('Agent run error', error);
        this.finishRun({
          success: false,
          error: error.message,
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
    // stream-json: write JSONL lines for each event (JSONL protocol)
    if (this.config.outputFormat === 'stream-json') {
      if (event.type === 'stream_chunk' && event.data?.content) {
        this.writeStreamJson('text', event.data.content);
      } else if (event.type === 'tool_call_start') {
        const toolName = event.data.name;
        const toolArgs = event.data.arguments;
        this.toolCallNames.set(event.data.id, toolName);
        if (toolName === 'spawn_agent' || toolName === 'task') {
          // Emit agent_dispatch for sub-agent spawning
          const agentRole = String(toolArgs?.role || toolArgs?.agent || 'unknown');
          const agentTask = String(toolArgs?.task || '');
          this.pendingAgentCalls.set(event.data.id, { agent: agentRole, task: agentTask });
          this.writeStreamJson('agent_dispatch', { agent: agentRole, task: agentTask });
        } else {
          this.writeStreamJson('tool_start', { name: toolName, args: toolArgs });
        }
      } else if (event.type === 'tool_call_end') {
        const toolCallId = event.data.toolCallId;
        const pending = this.pendingAgentCalls.get(toolCallId);
        if (pending) {
          // Emit agent_result for completed sub-agent
          this.pendingAgentCalls.delete(toolCallId);
          this.writeStreamJson('agent_result', {
            agent: pending.agent,
            result: event.data.output?.substring(0, 2000) || '',
            success: event.data.success,
          });
        } else {
          const name = this.toolCallNames.get(toolCallId) || 'unknown';
          this.toolCallNames.delete(toolCallId);
          this.writeStreamJson('tool_result', { name, result: { output: event.data.output } });
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
    } else {
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
      this.finishRun({
        success: true,
        output: this.lastContent || this.getLastAssistantMessage()?.content,
        toolsUsed: [...new Set(this.toolsUsed)],
        duration: Date.now() - this.startTime,
      });
    }

    // 错误处理
    if (event.type === 'error') {
      // 不立即结束，让 agent_complete 处理
      logger.warn('Agent error event', { message: event.data?.message });
    }
  }

  /**
   * 完成运行
   */
  private finishRun(result: CLIRunResult): void {
    this.isRunning = false;
    this.currentResult = result;
    this.currentAgentLoop = null;

    // Write metrics JSON if collector is active
    if (this.metricsCollector && this.config.metricsPath) {
      try {
        const fs = require('fs');
        const path = require('path');
        const metricsPath = path.resolve(this.config.metricsPath);
        const dir = path.dirname(metricsPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const metricsJson = this.metricsCollector.toJSON();
        fs.writeFileSync(metricsPath, metricsJson, 'utf-8');
        result.metricsPath = metricsPath;
        logger.info(`Metrics written to ${metricsPath}`);
      } catch (error) {
        logger.warn('Failed to write metrics file', { error: (error as Error).message });
      }
      this.metricsCollector = null;
    }

    // 取消 Swarm 事件监听
    if (this.unsubscribeSwarm) {
      this.unsubscribeSwarm();
      this.unsubscribeSwarm = null;
    }

    if (this.resolveRun) {
      this.resolveRun(result);
      this.resolveRun = null;
    }
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
   * 获取当前会话 ID
   */
  getSessionId(): string | null {
    return this.sessionId;
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
        id: `msg-ctx-${Date.now()}`,
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
        sessionManager.updateSession(this.sessionId, { prLink: link }).catch((error) => {
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
  const agent = new CLIAgent(options);
  await syncCLIWorkingDirectory(agent.getConfig().workingDirectory);
  return agent;
}

/**
 * 单次运行（便捷函数）
 */
export async function runOnce(
  prompt: string,
  options: Partial<CLIGlobalOptions> = {}
): Promise<CLIRunResult> {
  const agent = await createCLIAgent(options);
  const result = await agent.run(prompt);
  await cleanup();
  return result;
}
