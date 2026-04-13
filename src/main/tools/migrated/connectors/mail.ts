// ============================================================================
// Mail (P0-6.3 Batch 4 — connectors: native ToolModule rewrite)
//
// 旧版: src/main/tools/connectors/mail.ts (legacy Tool + wrapLegacyTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - connector 不可达 → NOT_INITIALIZED（legacy 原本 success:false + error string）
// - 行为保真：action 分发、输出格式化、中文文案完全保留
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';

const schema: ToolSchema = {
  name: 'mail',
  description: `Read local macOS Mail data via the native connector.

Supported actions:
- get_status
- list_accounts
- list_mailboxes
- list_messages
- read_message

For list_messages and read_message, provide mailbox. Account is optional but recommended when mailbox names may overlap.`,
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
  category: 'mcp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

type MailAction = 'get_status' | 'list_accounts' | 'list_mailboxes' | 'list_messages' | 'read_message';

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

async function executeMail(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string') {
    return { ok: false, error: 'action must be a string', code: 'INVALID_ARGS' };
  }
  const allowed: MailAction[] = ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'];
  if (!allowed.includes(action as MailAction)) {
    return { ok: false, error: `Unsupported mail action: ${action}`, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const connector = getConnectorRegistry().get('mail');
  if (!connector) {
    return { ok: false, error: 'Mail connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute(action, args);
    ctx.logger.debug('mail', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
      return {
        ok: true,
        output: `Mail connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`,
        meta: { status },
      };
    }

    if (action === 'list_accounts') {
      const accounts = result.data as Array<{ name: string }>;
      return {
        ok: true,
        output: accounts.length > 0
          ? `邮件账户 (${accounts.length})：\n- ${accounts.map((account) => account.name).join('\n- ')}`
          : '没有找到可访问的邮件账户。',
        meta: { count: accounts.length },
      };
    }

    if (action === 'list_mailboxes') {
      const mailboxes = result.data as Array<{ account: string; name: string }>;
      return {
        ok: true,
        output: mailboxes.length > 0
          ? `邮箱列表 (${mailboxes.length})：\n${mailboxes.map((box) => `- [${box.account}] ${box.name}`).join('\n')}`
          : '没有找到可访问的邮箱。',
        meta: { count: mailboxes.length },
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
        ok: true,
        output: messages.length > 0
          ? `邮件列表 (${messages.length})：\n${messages.map(formatMessage).join('\n')}`
          : '没有找到匹配的邮件。',
        meta: { count: messages.length },
      };
    }

    // read_message
    const message = result.data as {
      id: number;
      account?: string;
      mailbox?: string;
      subject: string;
      sender: string;
      receivedAtMs: number | null;
      read: boolean;
      content: string;
      attachments?: string[];
      attachmentCount?: number;
    };
    const received = message.receivedAtMs ? new Date(message.receivedAtMs).toLocaleString('zh-CN') : '未知时间';
    const attachmentCount = typeof message.attachmentCount === 'number'
      ? message.attachmentCount
      : (message.attachments?.length || 0);
    return {
      ok: true,
      output: `邮件 #${message.id}\n主题：${message.subject}\n发件人：${message.sender}\n时间：${received}\n状态：${message.read ? '已读' : '未读'}${attachmentCount > 0 ? `\n附件：${attachmentCount} 个${message.attachments && message.attachments.length > 0 ? ` (${message.attachments.join(', ')})` : ''}` : ''}\n\n内容：\n${message.content}`,
      meta: { id: message.id },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Mail connector failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

class MailHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMail(args, ctx, canUseTool, onProgress);
  }
}

export const mailModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MailHandler();
  },
};
