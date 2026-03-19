// ============================================================================
// Chat Command - 交互模式
// ============================================================================

import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { createCLIAgent, CLIAgent } from '../adapter';
import { terminalOutput } from '../output';
import { cleanup, initializeCLIServices, getSessionManager, getDatabaseService } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';
import { version } from '../../../package.json';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_PROVIDER, DEFAULT_MODELS, PROVIDER_REGISTRY, MODEL_PRICING_PER_1M } from '../../shared/constants';
import type { ModelProvider } from '../../shared/types';
import { getPRLinkService } from '../../main/services/github/prLinkService';

/** Provider → env var name mapping */
const PROVIDER_ENV_KEYS: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GOOGLE_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  moonshot: 'KIMI_K25_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  qwen: 'QWEN_API_KEY',
};

/** Mask API key: show prefix + last 4 chars */
function maskKey(key: string): string {
  if (key.length <= 8) return '····' + key.slice(-4);
  return key.slice(0, 4) + '····' + key.slice(-4);
}

/** Find the .env file path (first existing, or default) */
function getEnvFilePath(): string {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.code-agent', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // default to cwd/.env
}

/** Read raw API key input with masking (raw mode) */
function readMaskedInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const chars: string[] = [];

    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (buf: Buffer) => {
      const ch = buf.toString('utf8');

      // Enter
      if (ch === '\r' || ch === '\n') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write('\n');
        resolve(chars.join(''));
        return;
      }

      // Ctrl+C / ESC → cancel
      if (ch === '\x03' || ch === '\x1b') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write('\n');
        resolve('');
        return;
      }

      // Backspace
      if (ch === '\x7f' || ch === '\b') {
        if (chars.length > 0) {
          chars.pop();
          process.stdout.write('\b \b');
        }
        return;
      }

      // Paste support: handle multi-char input
      for (const c of ch) {
        if (c.charCodeAt(0) >= 32) {
          chars.push(c);
          // Show prefix clearly, mask the rest
          if (chars.length <= 6) {
            process.stdout.write(c);
          } else {
            process.stdout.write('•');
          }
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

/** Update or add a key=value in a .env file */
function upsertEnvFile(filePath: string, key: string, value: string): void {
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8');
  } else {
    // Ensure parent directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  // Also update process.env so it takes effect immediately
  process.env[key] = value;
}

export const chatCommand = new Command('chat')
  .description('进入交互式对话模式')
  .option('-s, --session <id>', '恢复指定会话')
  .option('-r, --resume', '恢复最近的会话')
  .option('--from-pr <pr>', '关联 GitHub PR (URL 或 #123)')
  .action(async (options: { session?: string; resume?: boolean; fromPr?: string }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    const isJsonMode = globalOpts?.json || globalOpts?.outputFormat === 'json' || globalOpts?.outputFormat === 'stream-json';

    try {
      // 初始化服务
      await initializeCLIServices();

      if (!isJsonMode) {
        // 显示欢迎横幅
        const db = getDatabaseService();
        const stats = db?.getStats();
        terminalOutput.welcome(version, {
          model: globalOpts?.model || DEFAULT_MODELS.chat,
          provider: globalOpts?.provider || DEFAULT_PROVIDER,
          workingDirectory: globalOpts?.project || process.cwd(),
          sessionCount: stats?.sessionCount,
          messageCount: stats?.messageCount,
        });
      }

      // 创建 Agent
      const agent = await createCLIAgent({
        project: globalOpts?.project,
        gen: globalOpts?.gen,
        model: globalOpts?.model,
        provider: globalOpts?.provider,
        json: globalOpts?.json,
        debug: globalOpts?.debug,
        outputFormat: globalOpts?.outputFormat,
        metrics: globalOpts?.metrics,
      });

      // 恢复会话
      if (options.session) {
        const restored = await agent.restoreSession(options.session);
        if (!isJsonMode) {
          if (restored) {
            terminalOutput.success(`已恢复会话: ${options.session}`);
            const history = agent.getHistory();
            terminalOutput.info(`历史消息: ${history.length} 条`);
          } else {
            terminalOutput.warning(`无法恢复会话: ${options.session}，创建新会话`);
          }
        }
      } else if (options.fromPr) {
        // 从 PR 关联
        await handlePRLink(options.fromPr, agent);
      } else if (options.resume) {
        // 恢复最近会话
        try {
          const sessionManager = getSessionManager();
          const recent = await sessionManager.getMostRecentSession();
          if (recent) {
            const restored = await agent.restoreSession(recent.id);
            if (!isJsonMode && restored) {
              terminalOutput.success(`已恢复最近会话: ${recent.title}`);
              const history = agent.getHistory();
              terminalOutput.info(`历史消息: ${history.length} 条`);
            }
          }
        } catch (error) {
          if (!isJsonMode) {
            terminalOutput.warning('无法恢复最近会话');
          }
        }
      }

      // Vim mode state
      let viMode = false;

      // 创建 readline 接口
      const createRl = () => readline.createInterface({
        input: process.stdin,
        output: isJsonMode ? undefined : process.stdout,
        terminal: !isJsonMode,
      });
      let rl = createRl();

      // ESC / Ctrl+C keypress handling
      if (!isJsonMode && process.stdin.isTTY) {
        readline.emitKeypressEvents(process.stdin);
        process.stdin.on('keypress', (_str: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
          if (!key) return;

          // ESC → cancel current agent run
          if (key.name === 'escape' && agent.getIsRunning()) {
            agent.cancel();
            terminalOutput.info('\n⎋ Interrupted');
            return;
          }

          // Ctrl+C → cancel during run, hint at prompt
          if (key.ctrl && key.name === 'c') {
            if (agent.getIsRunning()) {
              agent.cancel();
              terminalOutput.info('\n⎋ Interrupted');
            } else {
              terminalOutput.info('\nUse /exit to quit');
            }
          }
        });
      }

      // 主循环
      const promptUser = () => {
        if (!isJsonMode) {
          terminalOutput.prompt();
        }
      };

      rl.on('line', async (line) => {
        const input = line.trim();

        if (!input) {
          promptUser();
          return;
        }

        // P3-18: Bash shortcut - execute shell commands directly with !
        if (input.startsWith('!')) {
          const shellCmd = input.slice(1).trim();
          if (shellCmd) {
            try {
              const { execSync } = await import('child_process');
              const output = execSync(shellCmd, {
                cwd: globalOpts?.project || process.cwd(),
                encoding: 'utf-8',
                timeout: 30000,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
              if (output.trim()) {
                console.log(output);
              }
            } catch (error: unknown) {
              const errMsg = error instanceof Error ? error.message : String(error);
              if ((error as Record<string, unknown>).stdout) console.log((error as Record<string, unknown>).stdout);
              if ((error as Record<string, unknown>).stderr) console.error((error as Record<string, unknown>).stderr);
              else terminalOutput.error(errMsg || String(error));
            }
          }
          promptUser();
          return;
        }

        // 处理命令
        if (input.startsWith('/')) {
          const handled = await handleCommand(input, agent, rl, () => viMode, (v: boolean) => { viMode = v; });
          if (!handled) {
            promptUser();
          }
          return;
        }

        // 运行任务
        try {
          const result = await agent.run(input);
          if (!result.success && result.error) {
            terminalOutput.error(result.error);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          terminalOutput.error(message);
        }

        promptUser();
      });

      rl.on('close', async () => {
        if (!isJsonMode) {
          console.log('\n再见！\n');
        }
        await cleanup();
        process.exit(0);
      });

      // Prevent SIGINT from killing the process (handled via keypress)
      process.on('SIGINT', () => {
        // Handled by keypress listener above; this prevents default exit
      });

      // 开始
      promptUser();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      terminalOutput.error(message);
      await cleanup();
      process.exit(1);
    }
  });

/**
 * 处理斜杠命令
 */
async function handleCommand(
  input: string,
  agent: CLIAgent,
  rl: readline.Interface,
  getViMode?: () => boolean,
  setViMode?: (v: boolean) => void,
): Promise<boolean> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'help':
    case 'h':
      console.log(chalk.dim(`
  ${chalk.bold('Commands')}
  /help, /h           help
  /login              auth status & configure API keys
  /model [p/m]        switch model or list available
  /model key <p>      configure API key for provider
  /cost               token usage & cost
  /tools              list loaded tools
  /skills             list active skills
  /compact            trigger context compaction
  /clear, /c          new session
  /history            conversation history
  /sessions           list sessions
  /session            current session info
  /restore <id>       restore session
  /config             show config
  /vim                toggle vi mode
  !<cmd>              run shell command
  ESC                 interrupt current generation
  /exit, /quit        exit
`));
      return false;

    // ────────────────────────────────────────────────────
    // /login — 认证状态 + API Key 配置
    // ────────────────────────────────────────────────────
    case 'login': {
      if (args.length === 0) {
        // Show auth status dashboard
        console.log(chalk.dim(`\n  ${chalk.bold('Authentication')}\n`));
        for (const [id, info] of Object.entries(PROVIDER_REGISTRY)) {
          const envKey = PROVIDER_ENV_KEYS[id];
          const key = envKey ? process.env[envKey] || '' : '';
          if (key) {
            console.log(`  ${chalk.green('✓')} ${info.displayName.padEnd(16)} ${chalk.dim(maskKey(key))}`);
          } else {
            console.log(`  ${chalk.red('✗')} ${info.displayName.padEnd(16)} ${chalk.dim('—')}`);
          }
        }
        console.log(chalk.dim(`\n  /login <provider>  configure API key\n`));
      } else {
        // Configure specific provider
        const providerId = args[0].toLowerCase();
        const info = PROVIDER_REGISTRY[providerId as ModelProvider];
        if (!info) {
          terminalOutput.error(`Unknown provider: ${providerId}`);
          return false;
        }
        const envKey = PROVIDER_ENV_KEYS[providerId];
        if (!envKey) {
          terminalOutput.error(`No API key mapping for: ${providerId}`);
          return false;
        }

        const currentKey = process.env[envKey] || '';
        console.log(chalk.dim(`\n  Configure ${info.displayName}`));
        if (currentKey) {
          console.log(chalk.dim(`  Current key: ${maskKey(currentKey)}`));
        }
        console.log('');

        const newKey = await readMaskedInput(`  API Key: `);
        if (!newKey) {
          terminalOutput.info('Cancelled');
          return false;
        }

        // Save to .env
        const envPath = getEnvFilePath();
        upsertEnvFile(envPath, envKey, newKey);
        terminalOutput.success(`Saved to ${envPath}`);
      }
      return false;
    }

    // ────────────────────────────────────────────────────
    // /model — 切换模型 + key 子命令
    // ────────────────────────────────────────────────────
    case 'model':
    case 'm': {
      // /model key <provider> — configure API key (alias for /login <provider>)
      if (args[0]?.toLowerCase() === 'key') {
        const providerId = (args[1] || '').toLowerCase();
        if (!providerId) {
          terminalOutput.info('Usage: /model key <provider>');
          return false;
        }
        const info = PROVIDER_REGISTRY[providerId as ModelProvider];
        if (!info) {
          terminalOutput.error(`Unknown provider: ${providerId}`);
          return false;
        }
        const envKey = PROVIDER_ENV_KEYS[providerId];
        if (!envKey) {
          terminalOutput.error(`No API key mapping for: ${providerId}`);
          return false;
        }

        console.log(chalk.dim(`\n  Configure ${info.displayName} API Key`));
        const currentKey = process.env[envKey] || '';
        if (currentKey) {
          console.log(chalk.dim(`  Current: ${maskKey(currentKey)}`));
        }
        console.log('');

        const newKey = await readMaskedInput(`  API Key: `);
        if (!newKey) {
          terminalOutput.info('Cancelled');
          return false;
        }

        const envPath = getEnvFilePath();
        upsertEnvFile(envPath, envKey, newKey);
        terminalOutput.success(`Saved to ${envPath}`);
        return false;
      }

      if (args.length === 0) {
        // List available providers and models
        console.log(chalk.dim(`\n  ${chalk.bold('Available models')}\n`));
        const config = agent.getConfig();
        for (const [id, info] of Object.entries(PROVIDER_REGISTRY)) {
          const isCurrent = id === config.modelConfig.provider;
          const hasKey = !!(PROVIDER_ENV_KEYS[id] && process.env[PROVIDER_ENV_KEYS[id]]);
          const marker = isCurrent ? chalk.green(' ◄') : '';
          const keyStatus = hasKey ? chalk.green('✓') : chalk.red('✗');
          console.log(`  ${keyStatus} ${chalk.bold(info.displayName)} ${chalk.dim(`(${id})`)}${marker}`);
          console.log(chalk.dim(`    default: ${info.defaultModel}`));
        }
        console.log(chalk.dim(`\n  /model <provider>/<model>  switch model`));
        console.log(chalk.dim(`  /model key <provider>      configure API key\n`));
      } else {
        const modelInput = args[0];
        let provider: string;
        let model: string;
        if (modelInput.includes('/')) {
          [provider, model] = modelInput.split('/', 2);
        } else {
          provider = modelInput;
          const provInfo = PROVIDER_REGISTRY[provider as ModelProvider];
          model = provInfo?.defaultModel || modelInput;
        }
        const provInfo = PROVIDER_REGISTRY[provider as ModelProvider];
        if (!provInfo) {
          terminalOutput.error(`Unknown provider: ${provider}`);
        } else {
          agent.setModel(provider, model);
          terminalOutput.success(`Model switched to ${provInfo.displayName}/${model}`);
        }
      }
      return false;
    }

    // ────────────────────────────────────────────────────
    // /cost — Token 用量与成本
    // ────────────────────────────────────────────────────
    case 'cost': {
      const config = agent.getConfig();
      const history = agent.getHistory();
      const modelName = config.modelConfig.model;
      const pricing = MODEL_PRICING_PER_1M[modelName] || MODEL_PRICING_PER_1M['default'];

      // Use real token usage if available, fallback to estimate
      const realUsage = agent.getTokenUsage();
      let inputTokens: number;
      let outputTokens: number;
      let isEstimate = false;

      if (realUsage.inputTokens > 0 || realUsage.outputTokens > 0) {
        inputTokens = realUsage.inputTokens;
        outputTokens = realUsage.outputTokens;
      } else {
        // Fallback: ~4 chars per token heuristic
        let inputChars = 0;
        let outputChars = 0;
        for (const msg of history) {
          if (msg.role === 'user' || msg.role === 'system') {
            inputChars += (msg.content || '').length;
          } else {
            outputChars += (msg.content || '').length;
          }
        }
        inputTokens = Math.round(inputChars / 4);
        outputTokens = Math.round(outputChars / 4);
        isEstimate = true;
      }

      const totalCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
      const prefix = isEstimate ? '~' : '';

      console.log(chalk.dim(`\n  ${chalk.bold('Session cost')}`));
      console.log(chalk.dim(`  Model:    ${config.modelConfig.provider}/${modelName}`));
      console.log(chalk.dim(`  Messages: ${history.length}`));
      console.log(chalk.dim(`  Tokens:   ${prefix}${((inputTokens + outputTokens) / 1000).toFixed(1)}k (${(inputTokens / 1000).toFixed(1)}k in / ${(outputTokens / 1000).toFixed(1)}k out)`));
      console.log(chalk.dim(`  Cost:     ${prefix}$${totalCost.toFixed(4)}`));
      console.log(chalk.dim(`  Pricing:  $${pricing.input}/M in, $${pricing.output}/M out\n`));
      return false;
    }

    // ────────────────────────────────────────────────────
    // /tools — 列出已加载工具
    // ────────────────────────────────────────────────────
    case 'tools': {
      try {
        const { getToolExecutor } = await import('../bootstrap');
        const executor = getToolExecutor();
        if (executor) {
          const allTools = (executor as unknown as { toolRegistry: { getAllTools(): Array<{ name: string; description: string }> } }).toolRegistry.getAllTools();
          const mcpTools = allTools.filter(t => t.name.startsWith('mcp_') || t.name.startsWith('mcp__'));
          const builtinTools = allTools.filter(t => !t.name.startsWith('mcp_') && !t.name.startsWith('mcp__'));

          console.log(chalk.dim(`\n  ${chalk.bold('Tools')} (${allTools.length} total)\n`));

          if (builtinTools.length > 0) {
            console.log(chalk.dim(`  Built-in (${builtinTools.length}):`));
            const names = builtinTools.map(t => t.name).sort();
            // Print in columns
            for (let i = 0; i < names.length; i += 4) {
              const row = names.slice(i, i + 4).map(n => n.padEnd(22)).join('');
              console.log(chalk.dim(`    ${row}`));
            }
          }

          if (mcpTools.length > 0) {
            console.log(chalk.dim(`\n  MCP (${mcpTools.length}):`));
            for (const t of mcpTools.sort((a, b) => a.name.localeCompare(b.name))) {
              const desc = t.description ? t.description.substring(0, 50) : '';
              console.log(chalk.dim(`    🔌 ${t.name}`) + (desc ? chalk.dim(`  ${desc}`) : ''));
            }
          }
          console.log('');
        } else {
          terminalOutput.info('Tool executor not available');
        }
      } catch {
        terminalOutput.error('Failed to list tools');
      }
      return false;
    }

    // ────────────────────────────────────────────────────
    // /skills — 列出已激活 skill
    // ────────────────────────────────────────────────────
    case 'skills': {
      try {
        const { getSessionSkillService } = await import('../../main/services/skills/sessionSkillService');
        const skillService = getSessionSkillService();
        const sessionId = agent.getSessionId();
        if (sessionId) {
          const mounted = skillService.getMountedSkills(sessionId);
          if (mounted.length === 0) {
            console.log(chalk.dim('\n  No skills mounted\n'));
          } else {
            console.log(chalk.dim(`\n  ${chalk.bold('Active skills')} (${mounted.length})\n`));
            for (const s of mounted) {
              const marker = s.source === 'auto' ? chalk.dim(' [auto]') : '';
              console.log(chalk.cyanBright(`  ✦ ${chalk.bold(s.skillName)}${marker}`));
            }
            console.log('');
          }
        } else {
          terminalOutput.info('No active session');
        }
      } catch {
        terminalOutput.error('Failed to list skills');
      }
      return false;
    }

    // ────────────────────────────────────────────────────
    // /compact — 手动触发上下文压缩
    // ────────────────────────────────────────────────────
    case 'compact': {
      const history = agent.getHistory();
      const msgCount = history.length;
      if (msgCount < 4) {
        terminalOutput.info('Too few messages to compact');
      } else {
        // Simple compaction: keep last N messages, notify user
        terminalOutput.info(`Context has ${msgCount} messages. Compaction will be applied on next run.`);
        // Actual compaction happens inside AgentLoop's auto-compressor
        // This is a hint to the user
        terminalOutput.success('Compaction scheduled');
      }
      return false;
    }

    case 'clear':
    case 'c':
      agent.clearHistory();
      terminalOutput.success('Session cleared');
      return false;

    case 'history':
      const history = agent.getHistory();
      if (history.length === 0) {
        terminalOutput.info('暂无对话历史');
      } else {
        console.log('\n对话历史:');
        for (const msg of history) {
          const role = msg.role === 'user' ? '👤 用户' : '🤖 助手';
          const content = msg.content.length > 100
            ? msg.content.substring(0, 100) + '...'
            : msg.content;
          console.log(`  ${role}: ${content}`);
        }
        console.log('');
      }
      return false;

    case 'sessions':
      try {
        const sessionManager = getSessionManager();
        const sessions = await sessionManager.listSessions(10);
        if (sessions.length === 0) {
          terminalOutput.info('暂无会话');
        } else {
          console.log('\n最近会话:');
          for (const s of sessions) {
            const current = s.id === agent.getSessionId() ? ' (当前)' : '';
            const date = new Date(s.updatedAt).toLocaleString();
            console.log(`  ${s.id}: ${s.title} - ${s.messageCount} 条消息 - ${date}${current}`);
          }
          console.log('');
        }
      } catch (error) {
        terminalOutput.error('无法获取会话列表');
      }
      return false;

    case 'session':
      const sessionId = agent.getSessionId();
      if (sessionId) {
        try {
          const sessionManager = getSessionManager();
          const session = await sessionManager.getSession(sessionId);
          if (session) {
            console.log(`
当前会话:
  ID: ${session.id}
  标题: ${session.title}
  消息数: ${session.messageCount}
  创建时间: ${new Date(session.createdAt).toLocaleString()}
  更新时间: ${new Date(session.updatedAt).toLocaleString()}
`);
          }
        } catch (error) {
          terminalOutput.info(`会话 ID: ${sessionId}`);
        }
      } else {
        terminalOutput.info('尚未创建会话');
      }
      return false;

    case 'restore':
      if (args.length === 0) {
        terminalOutput.warn('请指定会话 ID: /restore <session_id>');
      } else {
        const restored = await agent.restoreSession(args[0]);
        if (restored) {
          terminalOutput.success(`已恢复会话: ${args[0]}`);
          const h = agent.getHistory();
          terminalOutput.info(`历史消息: ${h.length} 条`);
        } else {
          terminalOutput.error(`无法恢复会话: ${args[0]}`);
        }
      }
      return false;

    case 'config':
      const config = agent.getConfig();
      console.log(`
当前配置:
  工作目录: ${config.workingDirectory}
  模型: ${config.modelConfig.model}
  提供商: ${config.modelConfig.provider}
  调试模式: ${config.debug}
  会话 ID: ${agent.getSessionId() || '未创建'}
`);
      return false;

    case 'vim':
    case 'vi': {
      if (setViMode && getViMode) {
        const newMode = !getViMode();
        setViMode(newMode);
        terminalOutput.info(`Vi 模式已${newMode ? '开启' : '关闭'}（需要重启 readline 生效）`);
      } else {
        terminalOutput.info('Vi 模式不可用');
      }
      return false;
    }

    case 'exit':
    case 'quit':
    case 'q':
      rl.close();
      return true;

    default:
      terminalOutput.warn(`未知命令: /${cmd}`);
      return false;
  }
}

/**
 * 处理 PR 关联
 */
async function handlePRLink(prInput: string, agent: CLIAgent): Promise<void> {
  const prLinkService = getPRLinkService();

  // 尝试获取当前仓库上下文
  const currentRepo = await prLinkService.getCurrentRepo();

  // 解析 PR URL
  const parsed = prLinkService.parsePRUrl(prInput, currentRepo || undefined);
  if (!parsed) {
    terminalOutput.error(`无法解析 PR: ${prInput}`);
    terminalOutput.info('支持的格式: https://github.com/owner/repo/pull/123, owner/repo#123, #123');
    return;
  }

  terminalOutput.startThinking(`获取 PR #${parsed.number} 信息...`);

  // 获取 PR 上下文
  const context = await prLinkService.fetchPRContext(parsed.owner, parsed.repo, parsed.number);
  if (!context) {
    terminalOutput.stopThinking();
    terminalOutput.error(`无法获取 PR 信息，请确保已安装 gh CLI 并登录`);
    return;
  }

  // 获取变更文件列表
  const files = await prLinkService.fetchPRFiles(parsed.owner, parsed.repo, parsed.number);

  terminalOutput.stopThinking();

  // 显示 PR 信息
  terminalOutput.success(`已关联 PR #${context.number}: ${context.title}`);
  terminalOutput.info(`分支: ${context.headBranch} → ${context.baseBranch}`);
  terminalOutput.info(`变更: +${context.additions} / -${context.deletions} in ${context.changedFiles} files`);

  // 构建 PR 上下文 Prompt
  const prPrompt = prLinkService.buildPRPrompt(context, files);

  // 注入到 Agent 上下文（作为初始系统消息）
  agent.injectContext(`\n${prPrompt}\n`);

  // 创建 PRLink 对象
  const prLink = prLinkService.createPRLink(context);

  // 存储 PR 关联信息到会话
  agent.setPRLink(prLink);

  terminalOutput.info('PR 上下文已注入，可以开始讨论该 PR');
}
