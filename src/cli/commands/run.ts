// ============================================================================
// Run Command - 单次执行模式
// ============================================================================

import { Command } from 'commander';
import { createCLIAgent } from '../adapter';
import { terminalOutput, jsonOutput } from '../output';
import { cleanup, initializeCLIServices, getDatabaseService } from '../bootstrap';
import type { CLIGlobalOptions } from '../types';

export const runCommand = new Command('run')
  .description('执行单次任务')
  .argument('<prompt>', '要执行的任务描述')
  .option('-s, --session <id>', '恢复指定会话')
  .action(async (prompt: string, options: { session?: string }, command: Command) => {
    const globalOpts = command.parent?.opts() as CLIGlobalOptions;
    const isJson = globalOpts?.json || false;

    try {
      // 初始化服务
      await initializeCLIServices();

      // 显示数据库状态
      const db = getDatabaseService();
      if (!isJson && db) {
        const stats = db.getStats();
        if (globalOpts?.debug) {
          terminalOutput.info(`数据库: ${stats.sessionCount} 会话, ${stats.messageCount} 消息`);
        }
      }

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

      // 恢复会话（如果指定）
      if (options.session) {
        const restored = await agent.restoreSession(options.session);
        if (!isJson) {
          if (restored) {
            terminalOutput.info(`已恢复会话: ${options.session}`);
          } else {
            terminalOutput.warning(`无法恢复会话: ${options.session}，创建新会话`);
          }
        }
      }

      const result = await agent.run(prompt);

      // 显示会话 ID
      if (!isJson && agent.getSessionId()) {
        terminalOutput.info(`会话 ID: ${agent.getSessionId()}`);
      }

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
