// ============================================================================
// Exec Tool Command - 直接执行本地工具
// ============================================================================

import { Command } from 'commander';
import { runToolDirectly } from './_runToolDirectly';
import type { CLIGlobalOptions } from '../types';

export const execToolCommand = new Command('exec-tool')
  .description('直接执行单个已注册工具，不经过模型回合')
  .argument('<tool>', '工具名')
  .option('--params <json>', 'JSON object 格式的工具参数')
  .option('--params-file <path>', '从文件读取 JSON object 参数')
  .option('-s, --session <id>', '可选 session id')
  .action(async (tool: string, options: {
    params?: string;
    paramsFile?: string;
    session?: string;
  }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    await runToolDirectly(tool, options, globalOpts ?? {});
  });
