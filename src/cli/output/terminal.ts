// ============================================================================
// Terminal Output - 终端输出格式化
// ============================================================================

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { AgentEvent, ToolCall, ToolResult } from '../../shared/types';

/**
 * 终端输出管理器
 */
export class TerminalOutput {
  private spinner: Ora | null = null;
  private currentContent: string = '';
  private isStreaming: boolean = false;

  /**
   * 显示欢迎信息
   */
  welcome(version: string): void {
    console.log(chalk.cyan.bold(`\n🤖 Code Agent CLI v${version}\n`));
  }

  /**
   * 显示提示符
   */
  prompt(): void {
    process.stdout.write(chalk.green('> '));
  }

  /**
   * 开始思考 spinner
   */
  startThinking(message: string = '思考中...'): void {
    this.spinner = ora({
      text: chalk.dim(message),
      spinner: 'dots',
    }).start();
  }

  /**
   * 更新 spinner 文本
   */
  updateThinking(message: string): void {
    if (this.spinner) {
      this.spinner.text = chalk.dim(message);
    }
  }

  /**
   * 停止 spinner
   */
  stopThinking(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  /**
   * 显示工具调用
   */
  toolCall(toolCall: ToolCall): void {
    this.stopThinking();
    const args = JSON.stringify(toolCall.arguments, null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : '    ' + line))
      .join('\n');
    console.log(chalk.yellow(`\n🔧 ${toolCall.name}`));
    if (Object.keys(toolCall.arguments || {}).length > 0) {
      console.log(chalk.dim(`   ${args.substring(0, 200)}${args.length > 200 ? '...' : ''}`));
    }
  }

  /**
   * 显示工具结果
   */
  toolResult(result: ToolResult): void {
    if (result.success) {
      const output = result.output || '';
      const preview = output.length > 100 ? output.substring(0, 100) + '...' : output;
      console.log(chalk.green(`   ✓ ${preview.replace(/\n/g, ' ')}`));
    } else {
      console.log(chalk.red(`   ✗ ${result.error}`));
    }
  }

  /**
   * 开始流式输出
   */
  startStream(): void {
    this.stopThinking();
    this.isStreaming = true;
    this.currentContent = '';
    process.stdout.write('\n');
  }

  /**
   * 流式输出内容
   */
  streamChunk(content: string): void {
    if (!this.isStreaming) {
      this.startStream();
    }
    this.currentContent += content;
    process.stdout.write(content);
  }

  /**
   * 结束流式输出
   */
  endStream(): void {
    if (this.isStreaming) {
      this.isStreaming = false;
      console.log('\n');
    }
  }

  /**
   * 显示完整消息
   */
  message(content: string): void {
    this.stopThinking();
    if (!this.isStreaming) {
      console.log('\n' + content + '\n');
    } else {
      this.endStream();
    }
  }

  /**
   * 显示错误
   */
  error(message: string): void {
    this.stopThinking();
    console.error(chalk.red(`\n❌ 错误: ${message}\n`));
  }

  /**
   * 显示警告
   */
  warn(message: string): void {
    console.log(chalk.yellow(`\n⚠️  ${message}`));
  }

  /**
   * 显示警告（别名）
   */
  warning(message: string): void {
    this.warn(message);
  }

  /**
   * 显示信息
   */
  info(message: string): void {
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  /**
   * 显示成功
   */
  success(message: string): void {
    console.log(chalk.green(`\n✅ ${message}\n`));
  }

  /**
   * 显示任务完成摘要
   */
  taskComplete(duration: number, toolsUsed: string[]): void {
    this.stopThinking();
    const durationStr = duration < 1000
      ? `${duration}ms`
      : `${(duration / 1000).toFixed(1)}s`;
    console.log(chalk.dim(`\n─────────────────────────────────`));
    console.log(chalk.dim(`⏱  耗时: ${durationStr}`));
    if (toolsUsed.length > 0) {
      console.log(chalk.dim(`🔧 工具: ${[...new Set(toolsUsed)].join(', ')}`));
    }
    console.log(chalk.dim(`─────────────────────────────────\n`));
  }

  /**
   * 处理 Agent 事件
   */
  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'task_progress':
        if (event.data?.phase === 'thinking') {
          this.startThinking(event.data.step || '思考中...');
        } else if (event.data?.phase === 'tool_running') {
          this.updateThinking(event.data.step || '执行工具...');
        }
        break;

      case 'stream_chunk':
        if (event.data?.content) {
          this.streamChunk(event.data.content);
        }
        break;

      case 'tool_call_start':
        if (event.data) {
          this.toolCall(event.data as ToolCall);
        }
        break;

      case 'tool_call_end':
        if (event.data) {
          this.toolResult(event.data as ToolResult);
        }
        break;

      case 'message':
        if (event.data?.role === 'assistant' && event.data?.content) {
          // 如果已经流式输出了，不再重复显示
          if (!this.isStreaming && !this.currentContent) {
            this.message(event.data.content);
          }
        }
        break;

      case 'error':
        this.error(event.data?.message || '未知错误');
        break;

      case 'task_complete':
        this.endStream();
        if (event.data) {
          this.taskComplete(event.data.duration || 0, event.data.toolsUsed || []);
        }
        break;

      case 'agent_complete':
        this.stopThinking();
        break;
    }
  }
}

// 导出单例
export const terminalOutput = new TerminalOutput();
