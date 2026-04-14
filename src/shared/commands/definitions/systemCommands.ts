// ============================================================================
// System Commands - /help, /config
// ============================================================================

import type { CommandDefinition } from '../types';
import { getCommandRegistry } from '../commandRegistry';

export const helpCommand: CommandDefinition = {
  id: 'help',
  name: '帮助',
  description: '显示可用命令列表',
  category: 'system',
  surfaces: ['cli', 'gui'],
  aliases: ['h'],
  handler: async (ctx) => {
    const registry = getCommandRegistry();
    const commands = registry.list(ctx.surface);

    const lines: string[] = ['Commands'];
    for (const cmd of commands) {
      const aliases = cmd.aliases?.length ? `, /${cmd.aliases.join(', /')}` : '';
      lines.push(`  /${cmd.id}${aliases}  ${cmd.description}`);
    }

    ctx.output.info(lines.join('\n'));
    return { success: true };
  },
};

export const configCommand: CommandDefinition = {
  id: 'config',
  name: '配置',
  description: '查看当前配置',
  category: 'system',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getConfig?: () => {
        workingDirectory: string;
        modelConfig: { model: string; provider: string };
        debug: boolean;
      };
      getSessionId?: () => string | null;
    } | undefined;

    if (!agent?.getConfig) {
      ctx.output.error('Agent not available');
      return { success: false };
    }

    const config = agent.getConfig();
    const sessionId = agent.getSessionId?.() || '未创建';

    ctx.output.info(
      `当前配置:\n` +
      `  工作目录: ${config.workingDirectory}\n` +
      `  模型: ${config.modelConfig.model}\n` +
      `  提供商: ${config.modelConfig.provider}\n` +
      `  调试模式: ${config.debug}\n` +
      `  会话 ID: ${sessionId}`
    );

    return {
      success: true,
      data: {
        workingDirectory: config.workingDirectory,
        model: config.modelConfig.model,
        provider: config.modelConfig.provider,
        sessionId,
      },
    };
  },
};

export const systemCommands: CommandDefinition[] = [
  helpCommand,
  configCommand,
];
