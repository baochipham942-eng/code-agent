// ============================================================================
// Teammate Tool - Agent 间直接通信工具
// Gen 7: Multi-Agent capability
// ============================================================================
// 实现类似 Claude Code TeammateTool 的功能
// 支持 Agent 之间发送协调消息、任务交接、查询等
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import { getTeammateService } from '../teammate';
import type { TeammateMessageType } from '../teammate';

type TeammateAction =
  | 'send'       // 发送消息
  | 'coordinate' // 协调通知
  | 'handoff'    // 任务交接
  | 'query'      // 查询请求
  | 'respond'    // 响应查询
  | 'broadcast'  // 广播消息
  | 'inbox'      // 查看收件箱
  | 'agents'     // 列出所有 Agent
  | 'history';   // 查看对话历史

export const teammateTool: Tool = {
  name: 'teammate',
  description: `Communicate directly with other agents in the swarm.

Use this tool to:
- Send coordination messages to other agents
- Hand off tasks to specialized agents
- Query other agents for information
- Broadcast announcements to all agents
- Check messages from other agents

Actions:
- send: Send a message to a specific agent
- coordinate: Send a coordination notice (one-way)
- handoff: Transfer a task to another agent
- query: Ask another agent a question (expects response)
- respond: Respond to a query from another agent
- broadcast: Send a message to all agents
- inbox: View incoming messages
- agents: List all registered agents
- history: View conversation history with an agent

Parameters:
- action: What to do (required)
- to: Target agent ID (required for send/coordinate/handoff/query/respond)
- message: Message content (required for send/coordinate/handoff/query/respond/broadcast)
- responseTo: Original message ID (required for respond action)
- taskId: Related task ID (optional)`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['send', 'coordinate', 'handoff', 'query', 'respond', 'broadcast', 'inbox', 'agents', 'history'],
        description: 'Action to perform',
      },
      to: {
        type: 'string',
        description: 'Target agent ID',
      },
      message: {
        type: 'string',
        description: 'Message content',
      },
      responseTo: {
        type: 'string',
        description: 'Message ID to respond to',
      },
      taskId: {
        type: 'string',
        description: 'Related task ID',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as TeammateAction;
    const to = params.to as string | undefined;
    const message = params.message as string | undefined;
    const responseTo = params.responseTo as string | undefined;
    const taskId = params.taskId as string | undefined;

    const service = getTeammateService();

    // 获取当前 agent ID（如果有的话）
    const currentAgentId = context.agentId || context.sessionId || 'orchestrator';
    const currentAgentName = context.agentName || 'Orchestrator';

    // 确保当前 agent 已注册
    if (!service.getAgent(currentAgentId)) {
      service.register(currentAgentId, currentAgentName, context.agentRole || 'orchestrator');
    }

    switch (action) {
      // ========================================================================
      // 发送类操作
      // ========================================================================
      case 'send':
      case 'coordinate':
      case 'handoff':
      case 'query': {
        if (!to) {
          return { success: false, error: `'to' parameter required for ${action} action` };
        }
        if (!message) {
          return { success: false, error: `'message' parameter required for ${action} action` };
        }

        // 检查目标 agent 是否存在
        const targetAgent = service.getAgent(to);
        if (!targetAgent) {
          const available = service.listAgents().map(a => `${a.id} (${a.name})`);
          return {
            success: false,
            error: `Agent not found: ${to}. Available agents: ${available.join(', ') || 'none'}`,
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

        return {
          success: true,
          output: `Message sent to ${targetAgent.name} (${to})
Type: ${action}
Message ID: ${msg.id}
Content: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        };
      }

      case 'respond': {
        if (!to) {
          return { success: false, error: "'to' parameter required for respond action" };
        }
        if (!message) {
          return { success: false, error: "'message' parameter required for respond action" };
        }
        if (!responseTo) {
          return { success: false, error: "'responseTo' parameter required for respond action" };
        }

        const msg = service.respond(currentAgentId, to, message, responseTo);

        return {
          success: true,
          output: `Response sent to ${to}
In reply to: ${responseTo}
Message ID: ${msg.id}`,
        };
      }

      case 'broadcast': {
        if (!message) {
          return { success: false, error: "'message' parameter required for broadcast action" };
        }

        const msg = service.send({
          from: currentAgentId,
          to: 'all',
          type: 'broadcast',
          content: message,
          taskId,
        });

        const agentCount = service.listAgents().length - 1; // 排除自己

        return {
          success: true,
          output: `Broadcast sent to ${agentCount} agents
Message ID: ${msg.id}
Content: ${message.substring(0, 100)}${message.length > 100 ? '...' : ''}`,
        };
      }

      // ========================================================================
      // 查询类操作
      // ========================================================================
      case 'inbox': {
        const messages = service.getInbox(currentAgentId);

        if (messages.length === 0) {
          return {
            success: true,
            output: 'No messages in inbox.',
          };
        }

        const messageList = messages.map(m => {
          const fromAgent = service.getAgent(m.from);
          const fromName = fromAgent?.name || m.from;
          const typeIcon = {
            coordination: '📋',
            handoff: '🔄',
            query: '❓',
            response: '💬',
            broadcast: '📢',
          }[m.type];

          return `${typeIcon} [${m.id}] from ${fromName}
   Type: ${m.type}${m.metadata?.priority === 'high' ? ' (HIGH PRIORITY)' : ''}
   Time: ${new Date(m.timestamp).toLocaleTimeString()}
   Content: ${m.content.substring(0, 80)}${m.content.length > 80 ? '...' : ''}`;
        }).join('\n\n');

        return {
          success: true,
          output: `Inbox (${messages.length} messages):\n\n${messageList}`,
        };
      }

      case 'agents': {
        const agents = service.listAgents();

        if (agents.length === 0) {
          return {
            success: true,
            output: 'No agents registered.',
          };
        }

        const agentList = agents.map(a => {
          const statusIcon = {
            idle: '⏸️',
            working: '🔄',
            waiting: '⏳',
          }[a.status];
          const isSelf = a.id === currentAgentId ? ' (you)' : '';

          return `${statusIcon} [${a.id}] ${a.name}${isSelf}
   Role: ${a.role}
   Status: ${a.status}
   Last active: ${new Date(a.lastActiveAt).toLocaleTimeString()}`;
        }).join('\n\n');

        return {
          success: true,
          output: `Registered Agents (${agents.length}):\n\n${agentList}`,
        };
      }

      case 'history': {
        if (!to) {
          // 显示整体历史
          const history = service.getHistory(20);

          if (history.length === 0) {
            return {
              success: true,
              output: 'No message history.',
            };
          }

          const historyList = history.map(m => {
            const fromName = service.getAgent(m.from)?.name || m.from;
            const toName = m.to === 'all' ? 'ALL' : (service.getAgent(m.to)?.name || m.to);

            return `[${new Date(m.timestamp).toLocaleTimeString()}] ${fromName} → ${toName}: ${m.content.substring(0, 60)}${m.content.length > 60 ? '...' : ''}`;
          }).join('\n');

          return {
            success: true,
            output: `Recent Messages (${history.length}):\n\n${historyList}`,
          };
        }

        // 显示与特定 agent 的对话
        const conversation = service.getConversation(currentAgentId, to, 20);

        if (conversation.length === 0) {
          return {
            success: true,
            output: `No conversation history with ${to}.`,
          };
        }

        const toAgent = service.getAgent(to);
        const toName = toAgent?.name || to;

        const conversationList = conversation.map(m => {
          const isFrom = m.from === currentAgentId;
          const direction = isFrom ? '→' : '←';
          const name = isFrom ? 'You' : toName;

          return `[${new Date(m.timestamp).toLocaleTimeString()}] ${name} ${direction} ${m.content.substring(0, 80)}${m.content.length > 80 ? '...' : ''}`;
        }).join('\n');

        return {
          success: true,
          output: `Conversation with ${toName} (${conversation.length} messages):\n\n${conversationList}`,
        };
      }

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

// PascalCase alias for SDK compatibility
export const TeammateTool: Tool = {
  ...teammateTool,
  name: 'Teammate',
};
