// ============================================================================
// Model Commands - /model
// （/cost 由 newCommands.ts 的 costCommand 提供，此处不再重复定义）
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

export const modelCommands: CommandDefinition[] = [
  modelCommand,
];
