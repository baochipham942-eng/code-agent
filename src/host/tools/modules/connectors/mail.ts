// ============================================================================
// Mail (P0-6.3 Batch 4 — connectors: native ToolModule rewrite)
//
// 旧版: src/host/tools/connectors/mail.ts (legacy Tool + wrapLegacyTool)
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
} from '../../../protocol/tools';
import { getConnectorRegistry } from '../../../connectors';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { mailSchema as schema } from './mail.schema';

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

function buildMailMeta(
  ctx: ToolContext,
  action: string,
  output: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    action,
    connector: 'mail',
    ...metadata,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: 'text',
      sessionId: ctx.sessionId,
      name: `mail-${action}`,
      mimeType: 'text/markdown',
      contentLength: output.length,
      preview: output.slice(0, 500),
      metadata: {
        connector: 'mail',
        action,
        ...metadata,
      },
    }),
  };
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
    if (action === 'get_status') {
      const status = {
        connected: false,
        detail: 'Mail connector is not configured in this runtime.',
        capabilities: [] as string[],
        unavailable: true,
      };
      const output = `Mail connector: unavailable\n${status.detail}\nCapabilities: none`;
      return {
        ok: true,
        output,
        meta: buildMailMeta(ctx, action, output, { status }),
      };
    }
    return { ok: false, error: 'Mail connector is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    const result = await connector.execute(action, args);
    ctx.logger.debug('mail', { action });

    if (action === 'get_status') {
      const status = result.data as { connected: boolean; detail?: string; capabilities: string[] };
      const output = `Mail connector: ${status.connected ? 'connected' : 'disconnected'}\n${status.detail || ''}\nCapabilities: ${status.capabilities.join(', ')}`;
      return {
        ok: true,
        output,
        meta: buildMailMeta(ctx, action, output, { status }),
      };
    }

    if (action === 'list_accounts') {
      const accounts = result.data as Array<{ name: string }>;
      const output = accounts.length > 0
        ? `邮件账户 (${accounts.length})：\n- ${accounts.map((account) => account.name).join('\n- ')}`
        : '没有找到可访问的邮件账户。';
      return {
        ok: true,
        output,
        meta: buildMailMeta(ctx, action, output, { count: accounts.length, accounts }),
      };
    }

    if (action === 'list_mailboxes') {
      const mailboxes = result.data as Array<{ account: string; name: string }>;
      const output = mailboxes.length > 0
        ? `邮箱列表 (${mailboxes.length})：\n${mailboxes.map((box) => `- [${box.account}] ${box.name}`).join('\n')}`
        : '没有找到可访问的邮箱。';
      return {
        ok: true,
        output,
        meta: buildMailMeta(ctx, action, output, { count: mailboxes.length, mailboxes }),
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
      const output = messages.length > 0
        ? `邮件列表 (${messages.length})：\n${messages.map(formatMessage).join('\n')}`
        : '没有找到匹配的邮件。';
      return {
        ok: true,
        output,
        meta: buildMailMeta(ctx, action, output, { count: messages.length, messages }),
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
    const output = `邮件 #${message.id}\n主题：${message.subject}\n发件人：${message.sender}\n时间：${received}\n状态：${message.read ? '已读' : '未读'}${attachmentCount > 0 ? `\n附件：${attachmentCount} 个${message.attachments && message.attachments.length > 0 ? ` (${message.attachments.join(', ')})` : ''}` : ''}\n\n内容：\n${message.content}`;
    return {
      ok: true,
      output,
      meta: buildMailMeta(ctx, action, output, {
        id: message.id,
        subject: message.subject,
        sender: message.sender,
        account: message.account,
        mailbox: message.mailbox,
        receivedAtMs: message.receivedAtMs,
        read: message.read,
        attachmentCount,
        attachments: message.attachments,
      }),
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
