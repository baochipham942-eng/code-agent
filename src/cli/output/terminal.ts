// ============================================================================
// Terminal Output - 终端输出格式化
// ============================================================================

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { AgentEvent, ToolCall, ToolResult } from '../../shared/types';
import type { SwarmEvent, SwarmAgentState } from '../../shared/types/swarm';

// ♠♥♣♦ 旋转扑克牌思考动效
const POKER_SPINNER = {
  interval: 200,
  frames: ['♠', '♥', '♣', '♦'],
};

/**
 * 终端输出管理器
 */
export class TerminalOutput {
  private spinner: Ora | null = null;
  private currentContent: string = '';
  private isStreaming: boolean = false;
  private swarmAgents: Map<string, SwarmAgentState> = new Map();
  private swarmStartTime: number = 0;

  /** Accumulated token counts for status bar */
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  /** Turn counter */
  private turnCount: number = 0;
  /** Current model/provider (updated per model_response) */
  private currentModel: string = '';
  private currentProvider: string = '';
  /** Context window tracking */
  private contextUsagePercent: number = 0;
  private contextWindowSize: number = 0;
  private contextTokensUsed: number = 0;

  // ========================================================================
  // 头部
  // ========================================================================

  /**
   * 显示欢迎横幅
   */
  welcome(version: string, options?: {
    model?: string;
    provider?: string;
    workingDirectory?: string;
    sessionCount?: number;
    messageCount?: number;
  }): void {
    const termWidth = process.stdout.columns || 80;
    const line = chalk.dim('─'.repeat(Math.min(termWidth, 60)));

    // ASCII logo
    const logo = [
      '  ╔═══╗  ',
      '  ║ ◈ ║  ',
      '  ╚═══╝  ',
    ];

    // Initialize model tracking from welcome options
    if (options?.model) this.currentModel = options.model;
    if (options?.provider) this.currentProvider = options.provider;

    console.log('');
    console.log(line);

    // Line 1: logo + product name + version
    const nameVersion = `${chalk.bold('Code Agent')} ${chalk.dim(`v${version}`)}`;
    console.log(`${chalk.cyan(logo[0])}${nameVersion}`);

    // Line 2: logo + model info
    const model = options?.model || 'unknown';
    const provider = options?.provider || '';
    const modelInfo = chalk.dim(`${provider}/${model}`);
    console.log(`${chalk.cyan(logo[1])}${modelInfo}`);

    // Line 3: logo + working directory (abbreviated)
    const cwd = options?.workingDirectory || process.cwd();
    const home = require('os').homedir();
    const displayPath = cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    console.log(`${chalk.cyan(logo[2])}${chalk.dim(displayPath)}`);

    console.log(line);

    // Hints
    const hints = [
      chalk.dim('/help'),
      chalk.dim('/exit'),
      chalk.dim('!cmd'),
    ];
    console.log(chalk.dim(`  ${hints.join('  ·  ')}`));
    console.log('');
  }

  // ========================================================================
  // 提示符
  // ========================================================================

  prompt(): void {
    process.stdout.write(chalk.green('❯ '));
  }

  // ========================================================================
  // Token / Turn 追踪
  // ========================================================================

  addTokenUsage(input: number, output: number): void {
    this.totalInputTokens += input;
    this.totalOutputTokens += output;
  }

  incrementTurn(): void {
    this.turnCount++;
  }

  updateContextUsage(percent: number, tokensUsed?: number, windowSize?: number): void {
    this.contextUsagePercent = percent;
    if (tokensUsed) this.contextTokensUsed = tokensUsed;
    if (windowSize) this.contextWindowSize = windowSize;
  }

  // ========================================================================
  // 思考动效 — ♠♥♣♦ 旋转扑克牌
  // ========================================================================

  /**
   * 开始思考动效
   * @param message 显示文案
   * @param style 'thinking' | 'tool' | 'compacting' | 'research'
   */
  startThinking(message: string = 'Thinking...', style: 'thinking' | 'tool' | 'compacting' | 'research' = 'thinking'): void {
    this.stopThinking();

    const spinnerConfig = style === 'thinking' ? POKER_SPINNER : 'dots';
    const colorFn = style === 'thinking' ? chalk.cyan
      : style === 'tool' ? chalk.yellow
      : style === 'compacting' ? chalk.dim
      : chalk.magenta;

    this.spinner = ora({
      text: colorFn(`${message}`),
      spinner: spinnerConfig,
      color: style === 'thinking' ? 'cyan'
        : style === 'tool' ? 'yellow'
        : style === 'compacting' ? 'white'
        : 'magenta',
    }).start();
  }

  updateThinking(message: string): void {
    if (this.spinner) {
      this.spinner.text = chalk.dim(message);
    }
  }

  stopThinking(): void {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  // ========================================================================
  // 工具调用 — 分类图标 + 简洁参数
  // ========================================================================

  /**
   * 工具分类映射
   */
  private getToolIcon(name: string): { icon: string; color: typeof chalk } {
    // MCP tools: mcp_* or mcp__server__tool
    if (/^mcp[_]/.test(name)) {
      return { icon: '🔌', color: chalk.cyanBright };
    }
    // Skill
    if (/skill/i.test(name)) {
      return { icon: '✦', color: chalk.cyanBright };
    }
    // Memory
    if (/memory|remember/i.test(name)) {
      return { icon: '◆', color: chalk.green };
    }
    // File operations
    if (/read_file|write_file|edit_file|list_dir|glob/i.test(name)) {
      return { icon: '📄', color: chalk.blue };
    }
    // Shell / bash
    if (/bash|shell|terminal|exec/i.test(name)) {
      return { icon: '⚡', color: chalk.yellow };
    }
    // Search / grep
    if (/search|grep|find/i.test(name)) {
      return { icon: '🔍', color: chalk.magenta };
    }
    // Git
    if (/git/i.test(name)) {
      return { icon: '🔀', color: chalk.green };
    }
    // Web / fetch
    if (/web|fetch|http|url/i.test(name)) {
      return { icon: '🌐', color: chalk.cyan };
    }
    // Image / vision
    if (/image|screenshot|vision|photo/i.test(name)) {
      return { icon: '🎨', color: chalk.yellow };
    }
    // Agent / spawn
    if (/agent|spawn|delegate/i.test(name)) {
      return { icon: '🤖', color: chalk.magentaBright };
    }
    // Default
    return { icon: '●', color: chalk.yellow };
  }

  /**
   * 格式化 MCP 工具名：mcp__github__get_pr → mcp:github get_pr
   */
  private formatMcpToolName(name: string): { server: string; tool: string } {
    // mcp__server__tool format
    const match = name.match(/^mcp__([^_]+)__(.+)$/);
    if (match) {
      return { server: match[1], tool: match[2] };
    }
    // mcp_tool format
    const simpleMatch = name.match(/^mcp_(.+)$/);
    if (simpleMatch) {
      return { server: '', tool: simpleMatch[1] };
    }
    return { server: '', tool: name };
  }

  /**
   * 格式化工具参数为简洁的一行摘要
   */
  private formatToolArgs(args: Record<string, unknown>): string {
    // File tools: show path
    if (args.path || args.file_path) {
      const p = String(args.path || args.file_path);
      const home = require('os').homedir();
      const short = p.startsWith(home) ? '~' + p.slice(home.length) : p;
      return chalk.dim(short);
    }
    // Bash: show command
    if (args.command) {
      const cmd = String(args.command);
      return chalk.dim(cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd);
    }
    // Search: show pattern
    if (args.pattern || args.query) {
      return chalk.dim(`"${String(args.pattern || args.query)}"`);
    }
    // Skill: show skill name
    if (args.skill_name || args.name) {
      return chalk.dim(String(args.skill_name || args.name));
    }
    // URI (MCP resources)
    if (args.uri) {
      return chalk.dim(String(args.uri));
    }
    // Fallback: compact JSON
    const json = JSON.stringify(args);
    if (json.length > 2 && json !== '{}') {
      return chalk.dim(json.length > 60 ? json.substring(0, 57) + '...' : json);
    }
    return '';
  }

  /**
   * 显示工具调用
   */
  toolCall(toolCall: ToolCall): void {
    this.stopThinking();
    const { icon, color } = this.getToolIcon(toolCall.name);
    const args = toolCall.arguments || {};

    // Skill activation — special treatment (like Codex CLI)
    if (/skill/i.test(toolCall.name)) {
      const skillName = args.skill_name || args.name || 'unknown';
      console.log(chalk.cyanBright(`\n  ✦ Skill activated: ${chalk.bold(String(skillName))}`));
      return;
    }

    // MCP tools — show server:tool format
    if (/^mcp[_]/.test(toolCall.name)) {
      const { server, tool } = this.formatMcpToolName(toolCall.name);
      const label = server ? `${chalk.dim('mcp:')}${chalk.cyanBright(server)} ${chalk.bold(tool)}` : chalk.bold(tool);
      const argSummary = this.formatToolArgs(args);
      console.log(`\n  ${icon} ${label}` + (argSummary ? `  ${argSummary}` : ''));
      return;
    }

    // Memory tools — highlight
    if (/memory|remember/i.test(toolCall.name)) {
      const argSummary = this.formatToolArgs(args);
      console.log(chalk.green(`\n  ◆ ${chalk.bold(toolCall.name)}`) + (argSummary ? `  ${argSummary}` : ''));
      return;
    }

    // Default tools
    const argSummary = this.formatToolArgs(args);
    console.log(color(`\n  ${icon} ${chalk.bold(toolCall.name)}`) + (argSummary ? `  ${argSummary}` : ''));
  }

  /**
   * 显示工具结果
   */
  toolResult(result: ToolResult): void {
    if (result.success) {
      const output = result.output || '';
      if (output.length > 0) {
        const preview = output.length > 80 ? output.substring(0, 77) + '...' : output;
        console.log(chalk.dim(`    ✓ ${preview.replace(/\n/g, ' ')}`));
      } else {
        console.log(chalk.dim('    ✓ done'));
      }
    } else {
      console.log(chalk.red(`    ✗ ${result.error}`));
    }
  }

  // ========================================================================
  // 特殊事件展示
  // ========================================================================

  /**
   * 上下文压缩
   */
  contextCompressed(savedTokens: number, strategy?: string): void {
    const saved = savedTokens > 1000 ? `${(savedTokens / 1000).toFixed(1)}k` : `${savedTokens}`;
    const strategyHint = strategy ? chalk.dim(` (${strategy})`) : '';
    console.log(chalk.dim(`\n  ⟳ Context compacted: saved ${saved} tokens${strategyHint}`));
  }

  /**
   * 记忆学习完成
   */
  memoryLearned(data: { knowledgeExtracted: number; codeStylesLearned: number; toolPreferencesUpdated: number }): void {
    const parts: string[] = [];
    if (data.knowledgeExtracted > 0) parts.push(`${data.knowledgeExtracted} knowledge`);
    if (data.codeStylesLearned > 0) parts.push(`${data.codeStylesLearned} code styles`);
    if (data.toolPreferencesUpdated > 0) parts.push(`${data.toolPreferencesUpdated} tool prefs`);
    if (parts.length > 0) {
      console.log(chalk.green(`\n  ◆ Memory updated: ${parts.join(', ')}`));
    }
  }

  /**
   * API 重试提示
   */
  retrying(provider: string, attempt: number, maxRetries: number, delay: number): void {
    const delayStr = delay >= 1000 ? `${(delay / 1000).toFixed(0)}s` : `${delay}ms`;
    console.log(chalk.yellow(`  ↻ Retrying ${provider}... (${attempt}/${maxRetries}, ${delayStr})`));
  }

  /**
   * 模型降级
   */
  modelFallback(from: string, to: string, reason: string): void {
    console.log(chalk.yellow(`\n  ↻ ${from} → ${to}`) + chalk.dim(` (${reason})`));
    // Update tracked model
    this.currentModel = to;
  }

  /**
   * 预算预警
   */
  budgetWarning(current: number, max: number, percentage: number): void {
    const bar = this.renderMiniBar(percentage);
    console.log(chalk.yellow(`\n  ⚠ Budget ${bar} ${percentage.toFixed(0)}%: ¥${current.toFixed(2)} / ¥${max.toFixed(2)}`));
  }

  /**
   * 预算超限
   */
  budgetExceeded(current: number, max: number): void {
    console.log(chalk.red(`\n  ◉ Budget exceeded: ¥${current.toFixed(2)} / ¥${max.toFixed(2)} — paused`));
  }

  /**
   * 深度调研启动
   */
  researchStarted(topic: string, triggeredBy?: string): void {
    const trigger = triggeredBy === 'semantic' ? chalk.dim(' (auto)') : '';
    console.log(chalk.magenta(`\n  🔬 Research started: "${topic}"${trigger}`));
  }

  /**
   * 深度调研进度
   */
  researchProgress(_phase: string, percent: number, message: string): void {
    const bar = this.renderMiniBar(percent);
    console.log(chalk.magenta(`  🔬 ${bar} ${percent}% ${message}`));
  }

  /**
   * 渲染迷你进度条
   */
  private renderMiniBar(percent: number): string {
    const width = 10;
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    return chalk.green('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  }

  // ========================================================================
  // 流式输出
  // ========================================================================

  startStream(): void {
    this.stopThinking();
    this.isStreaming = true;
    this.currentContent = '';
    process.stdout.write('\n');
  }

  streamChunk(content: string): void {
    if (!this.isStreaming) {
      this.startStream();
    }
    this.currentContent += content;
    process.stdout.write(content);
  }

  endStream(): void {
    if (this.isStreaming) {
      this.isStreaming = false;
      console.log('\n');
    }
  }

  // ========================================================================
  // 消息
  // ========================================================================

  message(content: string): void {
    this.stopThinking();
    if (!this.isStreaming) {
      console.log('\n' + content + '\n');
    } else {
      this.endStream();
    }
  }

  error(message: string): void {
    this.stopThinking();
    console.error(chalk.red(`\n  ✗ ${message}\n`));
  }

  warn(message: string): void {
    console.log(chalk.yellow(`\n  ⚠ ${message}`));
  }

  warning(message: string): void {
    this.warn(message);
  }

  info(message: string): void {
    console.log(chalk.blue(`  ℹ ${message}`));
  }

  success(message: string): void {
    console.log(chalk.green(`\n  ✓ ${message}\n`));
  }

  // ========================================================================
  // 底部状态栏
  // ========================================================================

  /**
   * 显示任务完成摘要
   */
  taskComplete(duration: number, toolsUsed: string[]): void {
    this.stopThinking();

    const termWidth = process.stdout.columns || 80;
    const barWidth = Math.min(termWidth, 60);

    // Format duration
    const durationStr = duration < 1000
      ? `${duration}ms`
      : duration < 60000
        ? `${(duration / 1000).toFixed(1)}s`
        : `${Math.floor(duration / 60000)}m ${Math.round((duration % 60000) / 1000)}s`;

    // Format tokens
    const totalTokens = this.totalInputTokens + this.totalOutputTokens;
    const tokenStr = totalTokens > 0
      ? `${(totalTokens / 1000).toFixed(1)}k tokens`
      : '';

    // Git branch (best-effort)
    let gitBranch = '';
    try {
      const { execSync } = require('child_process');
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
    } catch { /* not in a git repo */ }

    // Unique tools count
    const toolCount = new Set(toolsUsed).size;

    // Model info (provider/model or just model)
    const modelLabel = this.currentModel
      ? (this.currentProvider ? `${this.currentProvider}/${this.currentModel}` : this.currentModel)
      : '';

    // Build status line: model · duration · tokens · context · tools · git
    const segments: string[] = [];
    if (modelLabel) segments.push(modelLabel);
    segments.push(durationStr);
    if (tokenStr) segments.push(tokenStr);
    // Context usage bar
    if (this.contextUsagePercent > 0) {
      const ctxBar = this.renderMiniBar(this.contextUsagePercent);
      const ctxLabel = this.contextTokensUsed > 0 && this.contextWindowSize > 0
        ? `${(this.contextTokensUsed / 1000).toFixed(0)}k/${(this.contextWindowSize / 1000).toFixed(0)}k`
        : `${this.contextUsagePercent.toFixed(0)}%`;
      const ctxColor = this.contextUsagePercent > 80 ? chalk.red : this.contextUsagePercent > 60 ? chalk.yellow : chalk.dim;
      segments.push(ctxColor(`ctx ${ctxBar} ${ctxLabel}`));
    }
    if (this.turnCount > 0) segments.push(`${this.turnCount} turns`);
    if (toolCount > 0) segments.push(`${toolCount} tools`);
    if (gitBranch) segments.push(`git:(${gitBranch})`);

    console.log('');
    console.log(chalk.dim('─'.repeat(barWidth)));
    console.log(chalk.dim(`  ${segments.join('  ·  ')}`));
    console.log(chalk.dim('─'.repeat(barWidth)));
    console.log('');
  }

  // ========================================================================
  // Swarm 事件可视化
  // ========================================================================

  handleSwarmEvent(event: SwarmEvent): void {
    switch (event.type) {
      case 'swarm:started': {
        this.swarmAgents.clear();
        this.swarmStartTime = event.timestamp;
        const total = event.data.statistics?.total ?? 0;
        console.log(chalk.cyan.bold(`\n  🤖 Agent Team started (${total} agents)\n`));
        break;
      }

      case 'swarm:agent:added': {
        const agent = event.data.agentState;
        if (agent) {
          this.swarmAgents.set(agent.id, agent);
          console.log(chalk.dim(`    [${agent.name || agent.id}]  ⏳ pending`));
        }
        break;
      }

      case 'swarm:agent:updated': {
        const agent = event.data.agentState;
        if (agent) {
          const existing = this.swarmAgents.get(agent.id);
          const merged = existing
            ? { ...existing, ...agent, name: agent.name || existing.name, role: agent.role || existing.role }
            : agent;
          this.swarmAgents.set(agent.id, merged);
          const label = merged.name || merged.id;
          const iter = merged.iterations ? `iter ${merged.iterations}` : '';
          const tools = merged.toolCalls ? `${merged.toolCalls} tools` : '';
          const detail = [iter, tools].filter(Boolean).join(', ');
          if (merged.status === 'running') {
            console.log(chalk.yellow(`    [${label}]  ♦ running${detail ? ` (${detail})` : ''}`));
          }
        }
        break;
      }

      case 'swarm:agent:completed': {
        const agent = event.data.agentState;
        if (agent) {
          const existing = this.swarmAgents.get(agent.id);
          const name = agent.name || existing?.name || agent.id;
          const dur = agent.endTime && (existing?.startTime || this.swarmStartTime)
            ? ((agent.endTime - (existing?.startTime || this.swarmStartTime)) / 1000).toFixed(1) + 's'
            : '';
          this.swarmAgents.set(agent.id, { ...(existing || agent), ...agent, status: 'completed' });
          console.log(chalk.green(`    [${name}]  ✓ done${dur ? ` (${dur})` : ''}`));
        }
        break;
      }

      case 'swarm:agent:failed': {
        const agent = event.data.agentState;
        if (agent) {
          const existing = this.swarmAgents.get(agent.id);
          const name = agent.name || existing?.name || agent.id;
          this.swarmAgents.set(agent.id, { ...(existing || agent), ...agent, status: 'failed' });
          console.log(chalk.red(`    [${name}]  ✗ ${agent.error || 'failed'}`));
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
        const status = failed === 0 ? chalk.green('done') : chalk.yellow(`${completed}/${total} done`);
        console.log(chalk.cyan.bold(`\n  🤖 Agent Team ${status} in ${totalTime}\n`));
        this.swarmAgents.clear();
        break;
      }

      case 'swarm:cancelled': {
        console.log(chalk.yellow(`\n  🤖 Agent Team cancelled\n`));
        this.swarmAgents.clear();
        break;
      }

      case 'swarm:agent:message': {
        const msg = event.data.message;
        if (msg) {
          const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '...' : msg.content;
          console.log(chalk.dim(`    💬 ${msg.from} → ${msg.to}: ${preview}`));
        }
        break;
      }

      case 'swarm:agent:plan_review': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.blue(`    📋 [${plan.agentId}] plan pending review`));
        }
        break;
      }

      case 'swarm:agent:plan_approved': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.green(`    📋 [${plan.agentId}] plan approved`));
        }
        break;
      }

      case 'swarm:agent:plan_rejected': {
        const plan = event.data.plan;
        if (plan) {
          console.log(chalk.red(`    📋 [${plan.agentId}] plan rejected: ${plan.feedback || ''}`));
        }
        break;
      }

      case 'swarm:user:message': {
        const msg = event.data.message;
        if (msg) {
          console.log(chalk.blue(`    📨 user → ${msg.to}: ${msg.content.slice(0, 80)}`));
        }
        break;
      }
    }
  }

  // ========================================================================
  // 主事件路由
  // ========================================================================

  handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'task_progress':
        if (event.data?.phase === 'thinking') {
          this.startThinking(event.data.step || 'Thinking...', 'thinking');
        } else if (event.data?.phase === 'tool_running') {
          this.startThinking(event.data.step || 'Running tool...', 'tool');
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
          if (!this.isStreaming && !this.currentContent) {
            this.message(event.data.content);
          }
        }
        break;

      case 'error':
        this.error(event.data?.message || 'Unknown error');
        break;

      case 'task_complete':
        this.endStream();
        if (event.data) {
          this.taskComplete(event.data.duration || 0, event.data.toolsUsed || []);
        }
        break;

      case 'model_response': {
        const d = event.data as { model?: string; provider?: string; inputTokens?: number; outputTokens?: number } | undefined;
        if (d?.inputTokens || d?.outputTokens) {
          this.addTokenUsage(d.inputTokens || 0, d.outputTokens || 0);
        }
        if (d?.model) this.currentModel = d.model;
        if (d?.provider) this.currentProvider = d.provider;
        this.incrementTurn();
        break;
      }

      // 上下文压缩 — 完整事件链
      case 'context_compacting': {
        const cp = event.data as { tokensBefore?: number; messagesCount?: number } | undefined;
        const tokensLabel = cp?.tokensBefore ? ` (${(cp.tokensBefore / 1000).toFixed(0)}k tokens)` : '';
        this.startThinking(`Compacting context${tokensLabel}...`, 'compacting');
        break;
      }
      case 'context_compacted': {
        const cd = event.data as { tokensBefore?: number; tokensAfter?: number; messagesRemoved?: number; duration_ms?: number } | undefined;
        this.stopThinking();
        if (cd?.tokensBefore && cd?.tokensAfter) {
          console.log(chalk.dim(`  ⊘ Compacted: ${(cd.tokensBefore / 1000).toFixed(0)}k → ${(cd.tokensAfter / 1000).toFixed(0)}k tokens`));
          this.updateContextUsage(
            (cd.tokensAfter / (this.contextWindowSize || cd.tokensBefore)) * 100,
            cd.tokensAfter,
          );
        }
        break;
      }
      case 'context_compressed': {
        const cc = event.data as { savedTokens: number; strategy?: string; maxTokens?: number; usagePercent?: number } | undefined;
        if (cc) {
          this.contextCompressed(cc.savedTokens, cc.strategy);
          if (cc.usagePercent) {
            this.updateContextUsage(cc.usagePercent, undefined, cc.maxTokens);
          }
        }
        break;
      }

      // task_stats — 真实上下文使用率
      case 'task_stats': {
        const ts = event.data as { contextUsage?: number; contextWindow?: number; tokensUsed?: number; iterations?: number } | undefined;
        if (ts) {
          if (ts.contextUsage != null) {
            this.updateContextUsage(ts.contextUsage * 100, ts.tokensUsed, ts.contextWindow);
          }
        }
        break;
      }

      // stream_usage — 实时 token 用量
      case 'stream_usage': {
        const su = event.data as { inputTokens?: number; outputTokens?: number } | undefined;
        if (su?.inputTokens || su?.outputTokens) {
          this.addTokenUsage(su?.inputTokens || 0, su?.outputTokens || 0);
        }
        break;
      }

      // 记忆学习
      case 'memory_learned': {
        const ml = event.data as { knowledgeExtracted: number; codeStylesLearned: number; toolPreferencesUpdated: number } | undefined;
        if (ml) {
          this.memoryLearned(ml);
        }
        break;
      }

      // 模型降级
      case 'model_fallback': {
        const mf = event.data as { from: string; to: string; reason: string } | undefined;
        if (mf) {
          this.modelFallback(mf.from, mf.to, mf.reason);
        }
        break;
      }

      // 预算预警
      case 'budget_warning': {
        const bw = event.data as { currentCost: number; maxBudget: number; usagePercentage: number } | undefined;
        if (bw) {
          this.budgetWarning(bw.currentCost, bw.maxBudget, bw.usagePercentage);
        }
        break;
      }

      // 预算超限
      case 'budget_exceeded': {
        const be = event.data as { currentCost: number; maxBudget: number } | undefined;
        if (be) {
          this.budgetExceeded(be.currentCost, be.maxBudget);
        }
        break;
      }

      // 深度调研启动
      case 'research_mode_started': {
        const rs = event.data as { topic: string; triggeredBy?: string } | undefined;
        if (rs) {
          this.researchStarted(rs.topic, rs.triggeredBy);
        }
        break;
      }

      // 深度调研进度
      case 'research_progress': {
        const rp = event.data as { phase: string; percent: number; message: string } | undefined;
        if (rp) {
          this.researchProgress(rp.phase, rp.percent, rp.message);
        }
        break;
      }

      // Turn 开始 — 显示 turn 计数
      case 'turn_start': {
        const ti = event.data as { iteration?: number } | undefined;
        if (ti?.iteration && ti.iteration > 1) {
          console.log(chalk.dim(`  ── turn ${ti.iteration} ──`));
        }
        break;
      }

      // 工具执行超时警告
      case 'tool_timeout': {
        const tt = event.data as { toolName?: string; elapsed?: number; threshold?: number } | undefined;
        if (tt) {
          const elapsed = tt.elapsed ? `${(tt.elapsed / 1000).toFixed(0)}s` : '';
          console.log(chalk.yellow(`  ⚠ ${tt.toolName || 'tool'} running for ${elapsed}...`));
        }
        break;
      }

      case 'agent_complete':
        this.stopThinking();
        break;
    }
  }
}

// 导出单例
export const terminalOutput = new TerminalOutput();
