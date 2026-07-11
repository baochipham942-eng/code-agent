// ============================================================================
// /btw — 只读侧聊（Kimi 借鉴 #3）
//
// 干活中途岔开问一个无关问题：开一个继承当前会话上下文、但禁用所有工具
// （只读）的临时子 agent 回答，答案打印给用户但不并回主线历史。
//
// CLI surface 先行（CLI 直接打印、天然不入 thread）；GUI 的 ephemeral 侧聊
// 渲染作为后续增量。核心只读原语在 main/agent/readOnlySideChat.ts（已单测）。
// 仿 /doctor：main 侧依赖走 handler 内动态 import，避免把 main 拽进 renderer 包。
// ============================================================================

import type { CommandContext, CommandDefinition, CommandResult } from '../types';

/** CLI 注入到 ctx.agent 的最小形状（避免 shared 依赖 main/cli 类型）。 */
interface SideChatAgentLike {
  getHistory(): unknown[];
  getConfig(): { modelConfig: unknown; workingDirectory: string };
}

export const btwCommand: CommandDefinition = {
  id: 'btw',
  name: '只读侧聊',
  description: '岔开问一个无关问题：继承当前上下文、禁用所有工具、不污染主线',
  category: 'session',
  surfaces: ['cli'],
  args: [{ name: 'question', description: '要岔开问的问题', required: true }],
  handler: async (ctx: CommandContext, args: string[]): Promise<CommandResult> => {
    const question = args.join(' ').trim();
    if (!question) {
      ctx.output.warn('用法：/btw <你的问题>');
      return { success: false, message: 'missing question' };
    }

    const agent = ctx.agent as SideChatAgentLike | undefined;
    if (typeof agent?.getHistory !== 'function' || typeof agent?.getConfig !== 'function') {
      ctx.output.error('/btw 当前仅在 CLI 聊天会话中可用');
      return { success: false, message: 'no agent context' };
    }

    try {
      const [{ runReadOnlySideChat }, { getToolResolver }, { getSubagentExecutor }] = await Promise.all([
        import('../../../host/agent/readOnlySideChat'),
        import('../../../host/tools/dispatch/toolResolver'),
        import('../../../host/agent/subagentExecutor'),
      ]);

      const cfg = agent.getConfig();
      // read-only：禁用所有工具，故 requestPermission 永不被触发；emit 无副作用
      ctx.output.info('（侧聊·只读）思考中…');
      const answer = await runReadOnlySideChat(
        {
          executor: getSubagentExecutor(),
          baseContext: {
            sessionId: 'btw-cli',
            cwd: cfg.workingDirectory,
            modelConfig: cfg.modelConfig as never,
            resolver: getToolResolver(),
            permission: { request: async () => false },
            events: { emit: () => { /* side-chat 无需事件 */ } },
            abortSignal: new AbortController().signal,
          },
          parentMessages: agent.getHistory() as never,
        },
        question,
      );

      ctx.output.info(answer || '（侧聊没有返回内容）');
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.output.error(`侧聊失败：${msg}`);
      return { success: false, message: msg };
    }
  },
};

export const btwCommands: CommandDefinition[] = [btwCommand];
