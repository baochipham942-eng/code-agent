// ============================================================================
// Code Agent CLI - Entry Point
// ============================================================================

// 🔴 必须在所有其他导入之前设置 CLI 模式标志
// 这让 native 模块（keytar 等）可以跳过加载
process.env.CODE_AGENT_CLI_MODE = 'true';
process.env.DOTENV_CONFIG_QUIET = 'true';

import { Command } from 'commander';
import { sessionCommand } from './commands/session';
import { version } from '../../package.json';

function requestedTopLevelCommand(args: string[]): string | null {
  const optionsWithValue = new Set([
    '-p', '--project', '--model', '--provider', '--output-format', '--system-prompt', '--metrics',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return null;
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('neo')
    .description('Agent Neo AI cowork 命令行工具')
    .version(version, '-v, --version', '显示版本号');

  // Global options
  program
    .option('-p, --project <path>', '项目目录', process.cwd())
    .option('--json', 'JSON 格式输出')
    .option('--model <name>', '模型名称')
    .option('--provider <name>', '模型提供商 (deepseek, openai, zhipu)')
    .option('--plan', '启用规划模式（复杂任务自动分解）')
    .option('--debug', '调试模式')
    .option('--output-format <format>', '输出格式 (text|json|stream-json)', 'text')
    .option('--system-prompt <prompt>', '自定义系统提示')
    .option('--metrics <path>', '会话结束后写入指标 JSON（用于 eval 分析）');

  program.addCommand(sessionCommand);

  // Session diagnostics must remain query-only even when the app is closed.
  // Avoid importing chat/browser/tool modules on this lightweight route because
  // some of those modules initialize writable runtime directories at import time.
  const args = process.argv.slice(2);
  const requestedCommand = requestedTopLevelCommand(args);
  const metadataOnly = requestedCommand == null
    && args.some((arg) => ['--help', '-h', '--version', '-v'].includes(arg));
  if (metadataOnly) {
    for (const [name, description] of [
      ['chat', '启动交互式对话'], ['run', '执行一次 Agent 任务'], ['serve', '启动服务'],
      ['export', '导出会话记录'], ['list-tools', '列出工具'], ['list-agents', '列出 Agent'],
      ['exec-tool', '直接执行工具'], ['init-soul', '初始化 Soul'],
      ['openchronicle', '管理屏幕记忆'], ['debug', '调试快照与回放'],
    ]) {
      program.command(name).description(description);
    }
  } else if (requestedCommand !== 'session') {
    const [
      { chatCommand }, { runCommand }, { serveCommand }, { exportCommand },
      { listToolsCommand }, { listAgentsCommand }, { execToolCommand },
      { initSoulCommand }, { openchronicleCommand }, { debugCommand },
    ] = await Promise.all([
      import('./commands/chat'), import('./commands/run'), import('./commands/serve'),
      import('./commands/export'), import('./commands/listTools'), import('./commands/listAgents'),
      import('./commands/execTool'), import('./commands/initSoul'),
      import('./commands/openchronicleCmd'), import('./commands/debug'),
    ]);
    program.addCommand(chatCommand);
    program.addCommand(runCommand);
    program.addCommand(serveCommand);
    program.addCommand(exportCommand);
    program.addCommand(listToolsCommand);
    program.addCommand(listAgentsCommand);
    program.addCommand(execToolCommand);
    program.addCommand(initSoulCommand);
    program.addCommand(openchronicleCommand);
    program.addCommand(debugCommand);
  }

  await program.parseAsync();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
