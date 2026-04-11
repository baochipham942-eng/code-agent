// ============================================================================
// Model Commands - /model, /cost
// ============================================================================

import type { CommandDefinition } from '../types';

export const modelCommand: CommandDefinition = {
  id: 'model',
  name: '模型',
  description: '查看或切换当前模型',
  category: 'model',
  surfaces: ['cli', 'gui'],
  aliases: ['m'],
  args: [
    { name: 'provider/model', description: '切换到指定 provider/model', required: false },
  ],
  handler: async (ctx) => {
    // 简化版：仅输出当前模型信息
    // 完整的交互式切换逻辑保留在 CLI surface 端
    const agent = ctx.agent as {
      getConfig?: () => { modelConfig: { provider: string; model: string } };
    } | undefined;

    if (!agent?.getConfig) {
      ctx.output.error('Agent not available');
      return { success: false };
    }

    const config = agent.getConfig();
    ctx.output.info(`当前模型: ${config.modelConfig.provider}/${config.modelConfig.model}`);
    return {
      success: true,
      data: {
        provider: config.modelConfig.provider,
        model: config.modelConfig.model,
      },
    };
  },
};

export const costCommand: CommandDefinition = {
  id: 'cost',
  name: '用量',
  description: 'Token 用量与成本',
  category: 'model',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getConfig?: () => { modelConfig: { provider: string; model: string } };
      getHistory?: () => Array<{ role: string; content: string }>;
      getTokenUsage?: () => { inputTokens: number; outputTokens: number };
    } | undefined;

    if (!agent?.getConfig || !agent?.getHistory || !agent?.getTokenUsage) {
      ctx.output.error('Agent not available');
      return { success: false };
    }

    const config = agent.getConfig();
    const history = agent.getHistory();
    const realUsage = agent.getTokenUsage();

    let inputTokens: number;
    let outputTokens: number;
    let isEstimate = false;

    if (realUsage.inputTokens > 0 || realUsage.outputTokens > 0) {
      inputTokens = realUsage.inputTokens;
      outputTokens = realUsage.outputTokens;
    } else {
      let inputChars = 0;
      let outputChars = 0;
      for (const msg of history) {
        if (msg.role === 'user' || msg.role === 'system') {
          inputChars += (msg.content || '').length;
        } else {
          outputChars += (msg.content || '').length;
        }
      }
      inputTokens = Math.round(inputChars / 4);
      outputTokens = Math.round(outputChars / 4);
      isEstimate = true;
    }

    const prefix = isEstimate ? '~' : '';
    const totalTokens = inputTokens + outputTokens;

    ctx.output.info(
      `Session cost\n` +
      `  Model:    ${config.modelConfig.provider}/${config.modelConfig.model}\n` +
      `  Messages: ${history.length}\n` +
      `  Tokens:   ${prefix}${(totalTokens / 1000).toFixed(1)}k (${(inputTokens / 1000).toFixed(1)}k in / ${(outputTokens / 1000).toFixed(1)}k out)`
    );

    return {
      success: true,
      data: { inputTokens, outputTokens, isEstimate, messageCount: history.length },
    };
  },
};

export const modelCommands: CommandDefinition[] = [
  modelCommand,
  costCommand,
];
