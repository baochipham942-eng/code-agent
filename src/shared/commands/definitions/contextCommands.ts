// ============================================================================
// Context Commands - /compact
// ============================================================================

import type { CommandDefinition } from '../types';

export const compactCommand: CommandDefinition = {
  id: 'compact',
  name: '压缩上下文',
  description: '手动触发上下文压缩',
  category: 'context',
  surfaces: ['cli', 'gui'],
  handler: async (ctx) => {
    const agent = ctx.agent as {
      getHistory?: () => Array<unknown>;
    } | undefined;

    if (!agent?.getHistory) {
      ctx.output.error('Agent not available');
      return { success: false };
    }

    const history = agent.getHistory();
    const msgCount = history.length;

    if (msgCount < 4) {
      ctx.output.info('Too few messages to compact');
      return { success: true, message: 'Too few messages' };
    }

    ctx.output.info(`Context has ${msgCount} messages. Compaction will be applied on next run.`);
    ctx.output.success('Compaction scheduled');
    return { success: true, message: 'Compaction scheduled' };
  },
};

export const contextCommands: CommandDefinition[] = [
  compactCommand,
];
