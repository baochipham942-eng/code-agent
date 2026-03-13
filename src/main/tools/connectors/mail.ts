// ============================================================================
// Mail Tool - Native macOS Mail connector
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getConnectorRegistry } from '../../connectors';

function formatMessage(item: {
  id: number;
  account?: string;
  mailbox?: string;
  subject: string;
  sender: string;
  receivedAtMs: number | null;
  read: boolean;
}): string {
  const received = item.receivedAtMs ? new Date(item.receivedAtMs).toLocaleString('zh-CN') : '未知时间';
  const scope = [item.account, item.mailbox].filter(Boolean).join(' / ');
  return `- #${item.id} ${item.subject}\n  ${scope || 'Mail'} | ${item.sender} | ${received}${item.read ? ' | 已读' : ' | 未读'}`;
}

export const mailTool: Tool = {
  name: 'mail',
  description: `Read local macOS Mail data via the native connector.

Supported actions:
- get_status
- list_accounts
- list_mailboxes
- list_messages
- read_message

For list_messages and read_message, provide mailbox. Account is optional but recommended when mailbox names may overlap.`,
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'],
        description: 'Mail action to perform.',
      },
      account: {
        type: 'string',
        description: 'Optional account name, used by list_mailboxes/list_messages/read_message.',
      },
      mailbox: {
        type: 'string',
        description: 'Mailbox name, required for list_messages/read_message.',
      },
      query: {
        type: 'string',
        description: 'Optional subject/sender filter for list_messages.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to return. Default: 10.',
      },
      scan_limit: {
        type: 'number',
        description: 'Maximum number of messages to scan before applying query filter. Optional.',
      },
      message_id: {
        type: 'number',
        description: 'Message id for read_message.',
      },
    },
    required: ['action'],
  },
  tags: ['planning', 'search'],
  aliases: ['mail', 'email', 'mailbox', 'read email'],
  source: 'builtin',
  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const connector = getConnectorRegistry().get('mail');
    if (!connector) {
      return { success: false, error: 'Mail connector is not available.' };
    }

    try {
      const result = await connector.execute(action, params);

      if (action === 'get_status') {
        const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
        return {
          success: true,
          output: `Mail connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
          result: status,
        };
      }

      if (action === 'list_accounts') {
        const accounts = result.data as Array<{ name: string }>;
        return {
          success: true,
          output: accounts.length > 0
            ? `邮件账户 (${accounts.length})：\n- ${accounts.map((account) => account.name).join('\n- ')}`
            : '没有找到可访问的邮件账户。',
          result: accounts,
        };
      }

      if (action === 'list_mailboxes') {
        const mailboxes = result.data as Array<{ account: string; name: string }>;
        return {
          success: true,
          output: mailboxes.length > 0
            ? `邮箱列表 (${mailboxes.length})：\n${mailboxes.map((box) => `- [${box.account}] ${box.name}`).join('\n')}`
            : '没有找到可访问的邮箱。',
          result: mailboxes,
        };
      }

      if (action === 'list_messages') {
        const messages = result.data as Array<{
          id: number;
          account?: string;
          mailbox?: string;
          subject: string;
          sender: string;
          receivedAtMs: number | null;
          read: boolean;
        }>;
        return {
          success: true,
          output: messages.length > 0
            ? `邮件列表 (${messages.length})：\n${messages.map(formatMessage).join('\n')}`
            : '没有找到匹配的邮件。',
          result: messages,
          metadata: { count: messages.length },
        };
      }

      if (action === 'read_message') {
        const message = result.data as {
          id: number;
          account?: string;
          mailbox?: string;
          subject: string;
          sender: string;
          receivedAtMs: number | null;
          read: boolean;
          content: string;
        };
        const received = message.receivedAtMs ? new Date(message.receivedAtMs).toLocaleString('zh-CN') : '未知时间';
        return {
          success: true,
          output: `邮件 #${message.id}\n主题：${message.subject}\n发件人：${message.sender}\n时间：${received}\n状态：${message.read ? '已读' : '未读'}\n\n内容：\n${message.content}`,
          result: message,
        };
      }

      return { success: false, error: `Unsupported mail action: ${action}` };
    } catch (error) {
      return {
        success: false,
        error: `Mail connector failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
