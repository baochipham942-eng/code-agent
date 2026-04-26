// ============================================================================
// Code Agent CLI - Entry Point
// ============================================================================

// 🔴 必须在所有其他导入之前设置 CLI 模式标志
// 这让 native 模块（keytar 等）可以跳过加载
process.env.CODE_AGENT_CLI_MODE = 'true';
process.env.DOTENV_CONFIG_QUIET = 'true';

import { Command } from 'commander';
import { chatCommand } from './commands/chat';
import { runCommand } from './commands/run';
import { serveCommand } from './commands/serve';
import { exportCommand } from './commands/export';
import { listToolsCommand } from './commands/listTools';
import { listAgentsCommand } from './commands/listAgents';
import { execToolCommand } from './commands/execTool';
import { initSoulCommand } from './commands/initSoul';
import { openchronicleCommand } from './commands/openchronicleCmd';
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
  .option('--gen <id>', '使用的代际 (gen1-gen8)')
  .option('--model <name>', '模型名称')
  .option('--provider <name>', '模型提供商 (deepseek, openai, zhipu)')
  .option('--plan', '启用规划模式（复杂任务自动分解）')
  .option('--debug', '调试模式')
  .option('--output-format <format>', '输出格式 (text|json|stream-json)', 'text')
  .option('--system-prompt <prompt>', '自定义系统提示')
  .option('--metrics <path>', '会话结束后写入指标 JSON（用于 eval 分析）');

// Register commands
program.addCommand(chatCommand);
program.addCommand(runCommand);
program.addCommand(serveCommand);
program.addCommand(exportCommand);
program.addCommand(listToolsCommand);
program.addCommand(listAgentsCommand);
program.addCommand(execToolCommand);
program.addCommand(initSoulCommand);
program.addCommand(openchronicleCommand);

// Parse and run
program.parse();
