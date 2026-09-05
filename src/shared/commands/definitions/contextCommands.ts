// ============================================================================
// Context Commands - /compact
// ============================================================================

import type { CommandDefinition } from '../types';
import { getCompactionCommandMessages } from '../../i18n/compactionCommand';

export const compactCommand: CommandDefinition = {
  id: 'compact',
  name: '压缩上下文',
  description: '手动触发上下文压缩',
  category: 'context',
  surfaces: ['cli', 'gui'],
  handler: async (ctx, args) => {
    const getLocale = ctx.getLocale as (() => 'zh' | 'en') | undefined;
    const text = getCompactionCommandMessages(getLocale?.() ?? 'zh');
    const agent = ctx.agent as {
      compactHistory?: (focusText?: string) => Promise<{
        success: boolean; reason?: string; beforeTokens: number; afterTokens: number;
      }>;
    } | undefined;
    if (!agent?.compactHistory) {
      ctx.output.error(text.unavailable);
      return { success: false };
    }
    try {
      const result = await agent.compactHistory(args.join(' ').trim() || undefined);
      if (!result.success) {
        const message = result.reason === 'compaction_active'
          ? text.compacting
          : result.reason === 'session_unavailable'
          ? text.sessionUnavailable
          : result.reason === 'run_active'
          ? text.busy
          : result.reason === 'history_changed'
            ? text.changed
            : result.reason === 'too_few_messages' || result.reason === 'no_safe_compaction_span'
              ? text.unchanged
              : result.reason === 'invalid_summary_projection'
                ? text.invalid
                : result.reason === 'summary_not_smaller'
                  ? text.notSmaller
                  : text.failed;
        ctx.output.warn(message);
        return { success: false, data: result };
      }
      const message = text.completed(result.beforeTokens, result.afterTokens);
      ctx.output.success(message);
      return { success: true, message, data: result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail === 'session_database_unavailable'
        ? text.databaseUnavailable : `${text.failed} ${detail}`;
      ctx.output.error(message);
      return { success: false };
    }
  },
};

export const contextCommands: CommandDefinition[] = [
  compactCommand,
];
