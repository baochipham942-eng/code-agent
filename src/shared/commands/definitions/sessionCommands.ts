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

function fmtAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortenDir(dir: string | undefined): string {
  if (!dir) return '';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home && dir.startsWith(home) ? '~' + dir.slice(home.length) : dir;
}

export const sessionsCommand: CommandDefinition = {
  id: 'sessions',
  name: '会话列表',
  description: '列出最近会话',
  category: 'session',
  surfaces: ['cli'],
  handler: async (ctx) => {
    const getSessionManager = ctx.getSessionManager as (() => { listSessions(n: number): Promise<Array<{ id: string; title: string; messageCount: number; updatedAt: number; workingDirectory?: string; gitBranch?: string; prLink?: { number: number } }>> }) | undefined;
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
          const current = s.id === currentId ? ' *' : '';
          const branch = s.gitBranch ? ` [${s.gitBranch}]` : '';
          const pr = s.prLink ? ` PR#${s.prLink.number}` : '';
          const dir = shortenDir(s.workingDirectory);
          const dirStr = dir ? `  ${dir}` : '';
          return `  ${s.title}${branch}${pr}  ${s.messageCount} msgs${dirStr}  ${fmtAgo(s.updatedAt)}${current}`;
        });
        ctx.output.info('Sessions:\n' + lines.join('\n'));
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

export const resumeCommand: CommandDefinition = {
  id: 'resume',
  name: '恢复会话',
  description: '恢复之前的会话上下文',
  category: 'session',
  surfaces: ['cli'],
  args: [
    { name: 'sessionId', description: '要恢复的会话 ID（可选，默认恢复最近未完成会话）', required: false },
  ],
  handler: async (ctx, args) => {
    const agent = ctx.agent as {
      getSessionId?: () => string | null;
      injectContext?: (text: string) => void;
    } | undefined;

    const currentSessionId = agent?.getSessionId?.();
    if (!currentSessionId) {
      ctx.output.error('No active session');
      return { success: false };
    }

    try {
      const targetId = args[0];

      if (!targetId) {
        // No arg: find most recent incomplete session in same working directory
        const { getSessionRecoveryService } = await import(
          '../../../main/agent/sessionRecovery'
        );
        // Get working directory from current session
        const getSessionManager = ctx.getSessionManager as (() => { getSession(id: string): Promise<{ workingDirectory?: string } | null> }) | undefined;
        let workingDirectory = process.cwd();
        if (getSessionManager) {
          const session = await getSessionManager().getSession(currentSessionId);
          if (session?.workingDirectory) workingDirectory = session.workingDirectory;
        }

        const recovery = await getSessionRecoveryService().checkPreviousSession(
          currentSessionId, workingDirectory
        );

        if (!recovery) {
          ctx.output.info('No incomplete session found to resume');
          return { success: true };
        }

        // Inject recovery context
        if (agent?.injectContext) {
          agent.injectContext(recovery);
          ctx.output.success('Previous session context injected. Ask me to continue the previous task.');
        } else {
          ctx.output.info(recovery);
        }
        return { success: true };
      }

      // Specific session id: load and build summary
      const getSessionManager = ctx.getSessionManager as (() => { getSession(id: string): Promise<{ id: string; title: string; workingDirectory?: string; messages?: Array<{ role: string; content?: string }> } | null> }) | undefined;
      if (!getSessionManager) {
        ctx.output.error('Session manager not available');
        return { success: false };
      }

      const session = await getSessionManager().getSession(targetId);
      if (!session) {
        ctx.output.error(`Session not found: ${targetId}`);
        return { success: false };
      }

      // Build a brief summary from the session
      const messages = session.messages ?? [];
      const userMessages = messages.filter(m => m.role === 'user' && m.content);
      const firstUserMsg = userMessages[0]?.content?.substring(0, 200) || 'unknown task';
      const lastUserMsg = userMessages.length > 1
        ? userMessages[userMessages.length - 1]?.content?.substring(0, 200)
        : undefined;

      const summary =
        `<session-recovery>\n` +
        `Resuming session "${session.title}" (${session.id.substring(0, 16)})\n` +
        `Working directory: ${session.workingDirectory || 'unknown'}\n` +
        `Messages: ${messages.length}\n` +
        `Original request: ${firstUserMsg}\n` +
        (lastUserMsg ? `Last user message: ${lastUserMsg}\n` : '') +
        `Continue from where this session left off.\n` +
        `</session-recovery>`;

      if (agent?.injectContext) {
        agent.injectContext(summary);
        ctx.output.success(`Session "${session.title}" context injected. Ask me to continue.`);
      } else {
        ctx.output.info(summary);
      }
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.output.error(`Resume failed: ${message}`);
      return { success: false, message };
    }
  },
};

export const sessionCommands: CommandDefinition[] = [
  clearCommand,
  sessionsCommand,
  historyCommand,
  resumeCommand,
];
