// ============================================================================
// Session Commands - /clear, /sessions, /history
// ============================================================================

import type { CommandDefinition } from '../types';

export const clearCommand: CommandDefinition = {
  id: 'clear',
  name: '清空对话',
  description: '清除当前会话消息',
  category: 'session',
  surfaces: ['cli', 'gui'],
  aliases: ['c'],
  handler: async (ctx) => {
    const agent = ctx.agent as { clearHistory?: () => void } | undefined;
    if (agent?.clearHistory) {
      agent.clearHistory();
    }
    ctx.output.success('Session cleared');
    return { success: true, message: 'Session cleared' };
  },
};

export const sessionsCommand: CommandDefinition = {
  id: 'sessions',
  name: '会话列表',
  description: '列出最近会话',
  category: 'session',
  surfaces: ['cli'],
  handler: async (ctx) => {
    const getSessionManager = ctx.getSessionManager as (() => { listSessions(n: number): Promise<Array<{ id: string; title: string; messageCount: number; updatedAt: number }>> }) | undefined;
    const agent = ctx.agent as { getSessionId?: () => string | null } | undefined;

    if (!getSessionManager) {
      ctx.output.error('Session manager not available');
      return { success: false, message: 'Session manager not available' };
    }

    try {
      const sessionManager = getSessionManager();
      const sessions = await sessionManager.listSessions(10);
      if (sessions.length === 0) {
        ctx.output.info('暂无会话');
      } else {
        const currentId = agent?.getSessionId?.();
        const lines = sessions.map(s => {
          const current = s.id === currentId ? ' (当前)' : '';
          const date = new Date(s.updatedAt).toLocaleString();
          return `  ${s.id}: ${s.title} - ${s.messageCount} 条消息 - ${date}${current}`;
        });
        ctx.output.info('最近会话:\n' + lines.join('\n'));
      }
      return { success: true };
    } catch {
      ctx.output.error('无法获取会话列表');
      return { success: false, message: '无法获取会话列表' };
    }
  },
};

export const historyCommand: CommandDefinition = {
  id: 'history',
  name: '对话历史',
  description: '查看当前会话消息',
  category: 'session',
  surfaces: ['cli'],
  handler: async (ctx) => {
    const agent = ctx.agent as { getHistory?: () => Array<{ role: string; content: string }> } | undefined;
    if (!agent?.getHistory) {
      ctx.output.error('Agent not available');
      return { success: false };
    }

    const history = agent.getHistory();
    if (history.length === 0) {
      ctx.output.info('暂无对话历史');
    } else {
      const lines = history.map(msg => {
        const role = msg.role === 'user' ? '👤 用户' : '🤖 助手';
        const content = msg.content.length > 100
          ? msg.content.substring(0, 100) + '...'
          : msg.content;
        return `  ${role}: ${content}`;
      });
      ctx.output.info('对话历史:\n' + lines.join('\n'));
    }
    return { success: true };
  },
};

export const sessionCommands: CommandDefinition[] = [
  clearCommand,
  sessionsCommand,
  historyCommand,
];
