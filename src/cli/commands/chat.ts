// ============================================================================
// Chat Command - 交互模式
// ============================================================================

import { Command } from 'commander';
import * as readline from 'readline';
import { createCLIAgent, CLIAgent } from '../adapter';
import { terminalOutput } from '../output';
import { cleanup, initializeCLIServices } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';
import { version } from '../../../package.json';

export const chatCommand = new Command('chat')
  .description('进入交互式对话模式')
  .action(async (options: unknown, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;

    try {
      // 初始化服务
      await initializeCLIServices();

      // 显示欢迎信息
      terminalOutput.welcome(version);
      terminalOutput.info(`项目目录: ${globalOpts?.project || process.cwd()}`);
      terminalOutput.info(`代际: ${globalOpts?.gen || 'gen3'}`);
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
  /clear, /c      清空对话历史
  /history        显示对话历史
  /config         显示当前配置
  /exit, /quit    退出程序
`);
      return false;

    case 'clear':
    case 'c':
      agent.clearHistory();
      terminalOutput.success('对话历史已清空');
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

    case 'config':
      const config = agent.getConfig();
      console.log(`
当前配置:
  工作目录: ${config.workingDirectory}
  代际: ${config.generationId}
  模型: ${config.modelConfig.model}
  提供商: ${config.modelConfig.provider}
  调试模式: ${config.debug}
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
