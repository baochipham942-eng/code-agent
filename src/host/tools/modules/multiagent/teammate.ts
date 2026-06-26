// ============================================================================
// Teammate (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/teammate.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND
// - 行为保真：9 action（send/coordinate/handoff/query/respond/broadcast/inbox/
//   agents/history）输出 1:1 复刻 legacy
//
// Opaque service handle 模式（关键样板）：
//   teammate 用 ctx.agentId / ctx.subagent?.agentName / ctx.subagent?.agentRole
//   读取当前 agent 身份。这三个都是 ProtocolToolContext 已结构化定义的字段，
//   无需 cast。teammate 也用 ctx.sessionId 作为 fallback。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getTeammateService } from '../../../agent/teammate';
import type { TeammateMessageType } from '../../../agent/teammate';
import { teammateSchema as schema } from './teammate.schema';
import { withMultiagentMeta } from './resultMeta';

type TeammateAction =
  | 'send' | 'coordinate' | 'handoff' | 'query' | 'respond'
  | 'broadcast' | 'inbox' | 'agents' | 'history';

const VALID_ACTIONS: readonly TeammateAction[] = [
  'send', 'coordinate', 'handoff', 'query', 'respond',
  'broadcast', 'inbox', 'agents', 'history',
];

export async function executeTeammate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as TeammateAction)) {
    return {
      ok: false,
      error: `Unknown action: ${String(action)}`,
      code: 'INVALID_ARGS',
    };
  }
  const to = typeof args.to === 'string' ? args.to : undefined;
  const message = typeof args.message === 'string' ? args.message : undefined;
  const responseTo = typeof args.responseTo === 'string' ? args.responseTo : undefined;
  const taskId = typeof args.taskId === 'string' ? args.taskId : undefined;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const service = getTeammateService();

  // Opaque ctx fields → 当前 agent 身份
  const currentAgentId = ctx.agentId || ctx.sessionId || 'orchestrator';
  const currentAgentName = ctx.subagent?.agentName || 'Orchestrator';
  const currentAgentRole = ctx.subagent?.agentRole || 'orchestrator';

  if (!service.getAgent(currentAgentId)) {
    service.register(currentAgentId, currentAgentName, currentAgentRole);
  }

  const result = ((): ToolResult<string> => {
    switch (action as TeammateAction) {
      case 'send':
      case 'coordinate':
      case 'handoff':
      case 'query': {
        if (!to) return { ok: false, error: `'to' parameter required for ${action} action`, code: 'INVALID_ARGS' };
        if (!message) return { ok: false, error: `'message' parameter required for ${action} action`, code: 'INVALID_ARGS' };

        const targetAgent = service.getAgent(to);
        if (!targetAgent) {
          const available = service.listAgents().map((a) => `${a.id} (${a.name})`);
          return {
            ok: false,
            error: `Agent not found: ${to}. Available agents: ${available.join(', ') || 'none'}`,
            code: 'NOT_FOUND',
          };
        }

        const typeMap: Record<string, TeammateMessageType> = {
          send: 'coordination',
          coordinate: 'coordination',
          handoff: 'handoff',
          query: 'query',
        };

        const msg = service.send({
          from: currentAgentId,
          to,
          type: typeMap[action],
          content: message,
          taskId,
          requiresResponse: action === 'query',
        });

        return withMultiagentMeta({
          ok: true,
          output: `Message sent to ${targetAgent.name} (${to})
Type: ${action}
Message ID: ${msg.id}
Content: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        }, ctx, schema.name, {
          action,
          agentId: currentAgentId,
          status: 'sent',
          targets: [to],
          counts: { bytes: message.length },
          result: { messageId: msg.id, type: typeMap[action], taskId },
        }, `Teammate ${action}: ${to}`);
      }

      case 'respond': {
        if (!to) return { ok: false, error: "'to' parameter required for respond action", code: 'INVALID_ARGS' };
        if (!message) return { ok: false, error: "'message' parameter required for respond action", code: 'INVALID_ARGS' };
        if (!responseTo) return { ok: false, error: "'responseTo' parameter required for respond action", code: 'INVALID_ARGS' };
        const msg = service.respond(currentAgentId, to, message, responseTo);
        return withMultiagentMeta({
          ok: true,
          output: `Response sent to ${to}
In reply to: ${responseTo}
Message ID: ${msg.id}`,
        }, ctx, schema.name, {
          action,
          agentId: currentAgentId,
          status: 'sent',
          targets: [to],
          counts: { bytes: message.length },
          result: { messageId: msg.id, responseTo },
        }, `Teammate response: ${to}`);
      }

      case 'broadcast': {
        if (!message) return { ok: false, error: "'message' parameter required for broadcast action", code: 'INVALID_ARGS' };
        const msg = service.send({
          from: currentAgentId,
          to: 'all',
          type: 'broadcast',
          content: message,
          taskId,
        });
        const agentCount = service.listAgents().length - 1;
        return withMultiagentMeta({
          ok: true,
          output: `Broadcast sent to ${agentCount} agents
Message ID: ${msg.id}
Content: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        }, ctx, schema.name, {
          action,
          agentId: currentAgentId,
          status: 'sent',
          targets: ['all'],
          counts: { agents: agentCount, bytes: message.length },
          result: { messageId: msg.id, taskId },
        }, 'Teammate broadcast');
      }

      case 'inbox': {
        const messages = service.getInbox(currentAgentId);
        if (messages.length === 0) {
          return withMultiagentMeta(
            { ok: true, output: 'No messages in inbox.' },
            ctx,
            schema.name,
            { action, agentId: currentAgentId, status: 'empty', counts: { messages: 0 }, result: [] },
            'Teammate inbox',
          );
        }
        const messageList = messages
          .map((m) => {
            const fromAgent = service.getAgent(m.from);
            const fromName = fromAgent?.name || m.from;
            const typeIcon = ({
              coordination: '📋',
              handoff: '🔄',
              query: '❓',
              response: '💬',
              broadcast: '📢',
            } as const)[m.type];
            return `${typeIcon} [${m.id}] from ${fromName}
   Type: ${m.type}${m.metadata?.priority === 'high' ? ' (HIGH PRIORITY)' : ''}
   Time: ${new Date(m.timestamp).toLocaleTimeString()}
   Content: ${m.content.substring(0, 80)}${m.content.length > 80 ? '...' : ''}`;
          })
          .join('\n\n');
        return withMultiagentMeta(
          { ok: true, output: `Inbox (${messages.length} messages):\n\n${messageList}` },
          ctx,
          schema.name,
          {
            action,
            agentId: currentAgentId,
            status: 'listed',
            targets: messages.map((m) => m.from),
            counts: { messages: messages.length },
            result: messages,
          },
          'Teammate inbox',
        );
      }

      case 'agents': {
        const agents = service.listAgents();
        if (agents.length === 0) {
          return withMultiagentMeta(
            { ok: true, output: 'No agents registered.' },
            ctx,
            schema.name,
            { action, agentId: currentAgentId, status: 'empty', counts: { agents: 0 }, result: [] },
            'Teammate agents',
          );
        }
        const agentList = agents
          .map((a) => {
            const statusIcon = ({ idle: '⏸️', working: '🔄', waiting: '⏳' } as const)[a.status];
            const isSelf = a.id === currentAgentId ? ' (you)' : '';
            return `${statusIcon} [${a.id}] ${a.name}${isSelf}
   Role: ${a.role}
   Status: ${a.status}
   Last active: ${new Date(a.lastActiveAt).toLocaleTimeString()}`;
          })
          .join('\n\n');
        return withMultiagentMeta(
          { ok: true, output: `Registered Agents (${agents.length}):\n\n${agentList}` },
          ctx,
          schema.name,
          {
            action,
            agentId: currentAgentId,
            status: 'listed',
            targets: agents.map((a) => a.id),
            counts: { agents: agents.length },
            result: agents,
          },
          'Teammate agents',
        );
      }

      case 'history': {
        if (!to) {
          const history = service.getHistory(20);
          if (history.length === 0) {
            return withMultiagentMeta(
              { ok: true, output: 'No message history.' },
              ctx,
              schema.name,
              { action, agentId: currentAgentId, status: 'empty', counts: { messages: 0 }, result: [] },
              'Teammate history',
            );
          }
          const historyList = history
            .map((m) => {
              const fromName = service.getAgent(m.from)?.name || m.from;
              const toName = m.to === 'all' ? 'ALL' : (service.getAgent(m.to)?.name || m.to);
              return `[${new Date(m.timestamp).toLocaleTimeString()}] ${fromName} → ${toName}: ${m.content.substring(0, 60)}${m.content.length > 60 ? '...' : ''}`;
            })
            .join('\n');
          return withMultiagentMeta(
            { ok: true, output: `Recent Messages (${history.length}):\n\n${historyList}` },
            ctx,
            schema.name,
            {
              action,
              agentId: currentAgentId,
              status: 'listed',
              targets: [...new Set(history.flatMap((m) => [m.from, m.to]))],
              counts: { messages: history.length },
              result: history,
            },
            'Teammate history',
          );
        }
        const conversation = service.getConversation(currentAgentId, to, 20);
        if (conversation.length === 0) {
          return withMultiagentMeta(
            { ok: true, output: `No conversation history with ${to}.` },
            ctx,
            schema.name,
            { action, agentId: currentAgentId, status: 'empty', targets: [to], counts: { messages: 0 }, result: [] },
            `Teammate history: ${to}`,
          );
        }
        const toAgent = service.getAgent(to);
        const toName = toAgent?.name || to;
        const conversationList = conversation
          .map((m) => {
            const isFrom = m.from === currentAgentId;
            const direction = isFrom ? '→' : '←';
            const name = isFrom ? 'You' : toName;
            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${name} ${direction} ${m.content.substring(0, 80)}${m.content.length > 80 ? '...' : ''}`;
          })
          .join('\n');
        return withMultiagentMeta({
          ok: true,
          output: `Conversation with ${toName} (${conversation.length} messages):\n\n${conversationList}`,
        }, ctx, schema.name, {
          action,
          agentId: currentAgentId,
          status: 'listed',
          targets: [to],
          counts: { messages: conversation.length },
          result: conversation,
        }, `Teammate history: ${to}`);
      }
    }
  })();

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('teammate done', { action, ok: result.ok });
  return result;
}

class TeammateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTeammate(args, ctx, canUseTool, onProgress);
  }
}

export const teammateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TeammateHandler();
  },
};
