// ============================================================================
// New Commands - /agents, /status, /plugins (stubs)
// ============================================================================

import type { CommandDefinition } from '../types';

export const agentsCommand: CommandDefinition = {
  id: 'agents',
  name: 'Agent 列表',
  description: '查看 Agent 历史记录',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    ctx.output.info('Agent 历史视图开发中');
    return { success: true, message: 'Agent 历史视图开发中' };
  },
};

export const statusCommand: CommandDefinition = {
  id: 'status',
  name: '状态',
  description: '查看当前会话状态',
  category: 'status',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getConfig?: () => { modelConfig: { provider: string; model: string } };
      getHistory?: () => Array<unknown>;
      getSessionId?: () => string | null;
      getTokenUsage?: () => { inputTokens: number; outputTokens: number };
    } | undefined;

    if (!agent?.getConfig) {
      ctx.output.info('Agent not available');
      return { success: false };
    }

    const config = agent.getConfig();
    const history = agent.getHistory?.() ?? [];
    const sessionId = agent.getSessionId?.() ?? 'N/A';
    const usage = agent.getTokenUsage?.();

    const totalTokens = usage ? usage.inputTokens + usage.outputTokens : 0;
    const tokenStr = totalTokens > 0
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : 'N/A';

    ctx.output.info(
      `Status\n` +
      `  Model:    ${config.modelConfig.provider}/${config.modelConfig.model}\n` +
      `  Session:  ${sessionId}\n` +
      `  Messages: ${history.length}\n` +
      `  Tokens:   ${tokenStr}`
    );

    return {
      success: true,
      data: {
        model: `${config.modelConfig.provider}/${config.modelConfig.model}`,
        sessionId,
        messageCount: history.length,
        totalTokens,
      },
    };
  },
};

export const pluginsCommand: CommandDefinition = {
  id: 'plugins',
  name: '插件',
  description: '管理已安装插件',
  category: 'tools',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    ctx.output.info('插件管理开发中');
    return { success: true, message: '插件管理开发中' };
  },
};

export const newCommands: CommandDefinition[] = [
  agentsCommand,
  statusCommand,
  pluginsCommand,
];
