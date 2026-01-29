// ============================================================================
// CLI Adapter - 适配 AgentLoop 到 CLI
// ============================================================================

import { createAgentLoop, buildCLIConfig, initializeCLIServices, cleanup } from './bootstrap';
import { terminalOutput, jsonOutput } from './output';
import type { CLIConfig, CLIRunResult, CLIGlobalOptions } from './types';
import type { Message, AgentEvent } from '../shared/types';
import { createLogger } from '../main/services/infra/logger';

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

  constructor(options: Partial<CLIGlobalOptions> = {}) {
    this.config = buildCLIConfig(options);
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

    // 添加用户消息
    const userMessage: Message = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: Date.now(),
    };
    this.messages.push(userMessage);

    // 创建 AgentLoop
    const agentLoop = createAgentLoop(
      this.config,
      this.handleEvent.bind(this),
      this.messages
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
      // 保存助手消息到历史
      const assistantMessage: Message = {
        id: event.data.id || `msg-${Date.now()}`,
        role: 'assistant',
        content: event.data.content || this.lastContent,
        timestamp: Date.now(),
        toolCalls: event.data.toolCalls,
      };
      this.messages.push(assistantMessage);
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
