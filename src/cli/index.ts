// ============================================================================
// Code Agent CLI - Entry Point
// ============================================================================

import { Command } from 'commander';
import { chatCommand } from './commands/chat';
import { runCommand } from './commands/run';
import { serveCommand } from './commands/serve';
import { version } from '../../package.json';

const program = new Command();

program
  .name('code-agent')
  .description('AI 编程助手命令行工具')
  .version(version, '-v, --version', '显示版本号');

// Global options
program
  .option('-p, --project <path>', '项目目录', process.cwd())
  .option('--json', 'JSON 格式输出')
  .option('--gen <id>', '使用的代际 (gen1-gen8)', 'gen3')
  .option('--model <name>', '模型名称')
  .option('--provider <name>', '模型提供商 (deepseek, openai, zhipu)')
  .option('--debug', '调试模式');

// Register commands
program.addCommand(chatCommand);
program.addCommand(runCommand);
program.addCommand(serveCommand);

// Parse and run
program.parse();
