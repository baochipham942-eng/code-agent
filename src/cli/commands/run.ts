// ============================================================================
// Run Command - 单次执行模式
// ============================================================================

import { Command } from 'commander';
import { createCLIAgent } from '../adapter';
import { terminalOutput, jsonOutput } from '../output';
import { cleanup, initializeCLIServices } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';

export const runCommand = new Command('run')
  .description('执行单次任务')
  .argument('<prompt>', '要执行的任务描述')
  .action(async (prompt: string, options: unknown, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    const isJson = globalOpts?.json || false;

    try {
      // 初始化服务
      await initializeCLIServices();

      if (!isJson) {
        terminalOutput.info(`项目目录: ${globalOpts?.project || process.cwd()}`);
        terminalOutput.info(`代际: ${globalOpts?.gen || 'gen3'}`);
        terminalOutput.startThinking('初始化中...');
      } else {
        jsonOutput.start();
      }

      // 创建 Agent 并运行
      const agent = await createCLIAgent({
        project: globalOpts?.project,
        gen: globalOpts?.gen,
        model: globalOpts?.model,
        provider: globalOpts?.provider,
        json: globalOpts?.json,
        debug: globalOpts?.debug,
      });

      const result = await agent.run(prompt);

      // 输出最终结果（JSON 模式）
      if (isJson) {
        jsonOutput.result(result);
      }

      // 设置退出码
      process.exitCode = result.success ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isJson) {
        jsonOutput.error(message);
      } else {
        terminalOutput.error(message);
      }

      process.exitCode = 1;
    } finally {
      await cleanup();
    }
  });
