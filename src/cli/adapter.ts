// ============================================================================
// CLI Adapter - 适配 AgentLoop 到 CLI
// ============================================================================

import { createAgentLoop, buildCLIConfig, initializeCLIServices, cleanup, getSessionManager } from './bootstrap';
import { terminalOutput, jsonOutput } from './output';
import { addSwarmEventListener } from '../main/ipc/swarm.ipc';
import type { CLIConfig, CLIRunResult, CLIGlobalOptions } from './types';
import type { Message, AgentEvent, GenerationId, PRLink } from '../shared/types';
import { createLogger } from '../main/services/infra/logger';
import { getSessionSkillService } from '../main/services/skills/sessionSkillService';

const logger = createLogger('CLI-Adapter');

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

  constructor(options: Partial<CLIGlobalOptions> = {}) {
    this.config = buildCLIConfig(options);
  }

  /**
   * 初始化会话
   */
  async initSession(): Promise<string> {
    const sessionManager = getSessionManager();
    const session = await sessionManager.getOrCreateCurrentSession({
      generationId: this.config.generationId as GenerationId,
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

    // 确保有会话
    if (!this.sessionId) {
      await this.initSession();
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
        if (this.config.outputFormat === 'json') {
          jsonOutput.handleSwarmEvent(event);
        } else {
          terminalOutput.handleSwarmEvent(event);
        }
      });
    }

    // 创建 AgentLoop（传入真实 sessionId）
    const agentLoop = createAgentLoop(
      this.config,
      this.handleEvent.bind(this),
      this.messages,
      this.sessionId || undefined
    );

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
   * 处理 Agent 事件
   */
  private handleEvent(event: AgentEvent): void {
    // 根据输出格式分发事件
    if (this.config.outputFormat === 'json') {
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

    if (event.type === 'message' && event.data?.role === 'assistant') {
      // 注意：不再手动 push 到 this.messages，因为 agentLoop.addAndPersistMessage()
      // 已经往共享的 messages 数组 push 了。重复 push 会导致结构化 tool_calls 协议错误
      // （两个 assistant 消息 back-to-back，API 400: tool_call_ids without response）
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
