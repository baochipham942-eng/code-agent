// ============================================================================
// Terminal Output - 终端输出格式化
// ============================================================================

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { AgentEvent, ToolCall, ToolResult } from '../../shared/types';
import type { SwarmEvent, SwarmAgentState } from '../../shared/types/swarm';

/**
 * 终端输出管理器
 */
export class TerminalOutput {
  private spinner: Ora | null = null;
  private currentContent: string = '';
  private isStreaming: boolean = false;
  private swarmAgents: Map<string, SwarmAgentState> = new Map();
  private swarmStartTime: number = 0;

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

  // ========================================================================
  // Swarm 事件可视化
  // ========================================================================

  /**
   * 处理 Swarm 事件，在终端展示 Agent Team 执行进度
   */
  handleSwarmEvent(event: SwarmEvent): void {
    switch (event.type) {
      case 'swarm:started': {
        this.swarmAgents.clear();
        this.swarmStartTime = event.timestamp;
        const total = event.data.statistics?.total ?? 0;
        console.log(chalk.cyan.bold(`\n🤖 Agent Team 启动 (${total} agents)\n`));
        break;
      }

      case 'swarm:agent:added': {
        const agent = event.data.agentState;
        if (agent) {
          this.swarmAgents.set(agent.id, agent);
          console.log(chalk.dim(`  [${agent.name || agent.id}]  ⏳ 等待中`));
        }
        break;
      }

      case 'swarm:agent:updated': {
        const agent = event.data.agentState;
        if (agent) {
          // 合并已有状态（emitter 发送时 name/role 可能为空）
          const existing = this.swarmAgents.get(agent.id);
          const merged = existing
            ? { ...existing, ...agent, name: agent.name || existing.name, role: agent.role || existing.role }
            : agent;
          this.swarmAgents.set(agent.id, merged);
          const label = merged.name || merged.id;
          const iter = merged.iterations ? `迭代 ${merged.iterations}` : '';
          const tools = merged.toolCalls ? `工具调用 ${merged.toolCalls}` : '';
          const detail = [iter, tools].filter(Boolean).join(', ');
          if (merged.status === 'running') {
            console.log(chalk.yellow(`  [${label}]  🔄 执行中${detail ? `... (${detail})` : ''}`));
          }
        }
        break;
      }

      case 'swarm:agent:completed': {
        const agent = event.data.agentState;
        if (agent) {
          const existing = this.swarmAgents.get(agent.id);
          const name = agent.name || existing?.name || agent.id;
          const duration = agent.endTime && (existing?.startTime || this.swarmStartTime)
            ? ((agent.endTime - (existing?.startTime || this.swarmStartTime)) / 1000).toFixed(1) + 's'
            : '';
          this.swarmAgents.set(agent.id, { ...(existing || agent), ...agent, status: 'completed' });
          console.log(chalk.green(`  [${name}]  ✅ 完成${duration ? ` (${duration})` : ''}`));
        }
        break;
      }

      case 'swarm:agent:failed': {
        const agent = event.data.agentState;
        if (agent) {
          const existing = this.swarmAgents.get(agent.id);
          const name = agent.name || existing?.name || agent.id;
          this.swarmAgents.set(agent.id, { ...(existing || agent), ...agent, status: 'failed' });
          console.log(chalk.red(`  [${name}]  ❌ 失败: ${agent.error || '未知错误'}`));
        }
        break;
      }

      case 'swarm:completed': {
        const stats = event.data.statistics;
        const result = event.data.result;
        const totalTime = result?.totalTime
          ? (result.totalTime / 1000).toFixed(1) + 's'
          : ((Date.now() - this.swarmStartTime) / 1000).toFixed(1) + 's';
        const completed = stats?.completed ?? 0;
        const failed = stats?.failed ?? 0;
        const total = stats?.total ?? this.swarmAgents.size;
        const status = failed === 0 ? chalk.green('成功') : chalk.yellow(`${completed}/${total} 成功`);
        console.log(chalk.cyan.bold(`\n🤖 Agent Team 完成 — ${status}, 耗时 ${totalTime}\n`));
        this.swarmAgents.clear();
        break;
      }

      case 'swarm:cancelled': {
        console.log(chalk.yellow(`\n🤖 Agent Team 已取消\n`));
        this.swarmAgents.clear();
        break;
      }

      case 'swarm:agent:message': {
        const msg = event.data.message;
        if (msg) {
          const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '...' : msg.content;
          console.log(chalk.dim(`  💬 ${msg.from} → ${msg.to}: ${preview}`));
        }
        break;
      }

      case 'swarm:agent:plan_review': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.blue(`  📋 [${plan.agentId}] 提交计划待审批`));
        }
        break;
      }

      case 'swarm:agent:plan_approved': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.green(`  📋 [${plan.agentId}] 计划已通过`));
        }
        break;
      }

      case 'swarm:agent:plan_rejected': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.red(`  📋 [${plan.agentId}] 计划被驳回: ${plan.feedback || ''}`));
        }
        break;
      }

      case 'swarm:user:message': {
        const msg = event.data.message;
        if (msg) {
          console.log(chalk.blue(`  📨 用户 → ${msg.to}: ${msg.content.slice(0, 80)}`));
        }
        break;
      }
    }
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
