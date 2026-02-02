// ============================================================================
// Chat Command - 交互模式
// ============================================================================

import { Command } from 'commander';
import * as readline from 'readline';
import { createCLIAgent, CLIAgent } from '../adapter';
import { terminalOutput } from '../output';
import { cleanup, initializeCLIServices, getSessionManager, getDatabaseService } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';
import { version } from '../../../package.json';
import { getPRLinkService } from '../../main/services/github/prLinkService';

export const chatCommand = new Command('chat')
  .description('进入交互式对话模式')
  .option('-s, --session <id>', '恢复指定会话')
  .option('-r, --resume', '恢复最近的会话')
  .option('--from-pr <pr>', '关联 GitHub PR (URL 或 #123)')
  .action(async (options: { session?: string; resume?: boolean; fromPr?: string }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;

    try {
      // 初始化服务
      await initializeCLIServices();

      // 显示欢迎信息
      terminalOutput.welcome(version);
      terminalOutput.info(`项目目录: ${globalOpts?.project || process.cwd()}`);
      terminalOutput.info(`代际: ${globalOpts?.gen || 'gen3'}`);

      // 显示数据库状态
      const db = getDatabaseService();
      if (db) {
        const stats = db.getStats();
        terminalOutput.info(`数据库: ${stats.sessionCount} 会话, ${stats.messageCount} 消息`);
      }

      console.log('输入 /help 查看命令，/exit 退出\n');

      // 创建 Agent
      const agent = await createCLIAgent({
        project: globalOpts?.project,
        gen: globalOpts?.gen,
        model: globalOpts?.model,
        provider: globalOpts?.provider,
        json: false,
        debug: globalOpts?.debug,
      });

      // 恢复会话
      if (options.session) {
        const restored = await agent.restoreSession(options.session);
        if (restored) {
          terminalOutput.success(`已恢复会话: ${options.session}`);
          const history = agent.getHistory();
          terminalOutput.info(`历史消息: ${history.length} 条`);
        } else {
          terminalOutput.warning(`无法恢复会话: ${options.session}，创建新会话`);
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
            if (restored) {
              terminalOutput.success(`已恢复最近会话: ${recent.title}`);
              const history = agent.getHistory();
              terminalOutput.info(`历史消息: ${history.length} 条`);
            }
          }
        } catch (error) {
          terminalOutput.warning('无法恢复最近会话');
        }
      }

      // 创建 readline 接口
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });

      // 主循环
      const promptUser = () => {
        terminalOutput.prompt();
      };

      rl.on('line', async (line) => {
        const input = line.trim();

        if (!input) {
          promptUser();
          return;
        }

        // 处理命令
        if (input.startsWith('/')) {
          const handled = await handleCommand(input, agent, rl);
          if (!handled) {
            promptUser();
          }
          return;
        }

        // 运行任务
        try {
          await agent.run(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          terminalOutput.error(message);
        }

        promptUser();
      });

      rl.on('close', async () => {
        console.log('\n再见！👋\n');
        await cleanup();
        process.exit(0);
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
  rl: readline.Interface
): Promise<boolean> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd.toLowerCase()) {
    case 'help':
    case 'h':
      console.log(`
可用命令:
  /help, /h       显示帮助
  /clear, /c      清空对话历史（创建新会话）
  /history        显示对话历史
  /sessions       列出所有会话
  /session        显示当前会话信息
  /restore <id>   恢复指定会话
  /config         显示当前配置
  /exit, /quit    退出程序
`);
      return false;

    case 'clear':
    case 'c':
      agent.clearHistory();
      terminalOutput.success('对话历史已清空，将创建新会话');
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
  代际: ${config.generationId}
  模型: ${config.modelConfig.model}
  提供商: ${config.modelConfig.provider}
  调试模式: ${config.debug}
  会话 ID: ${agent.getSessionId() || '未创建'}
`);
      return false;

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
