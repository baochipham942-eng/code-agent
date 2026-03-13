// ============================================================================
// Native Mail Connector - macOS Mail via AppleScript
// ============================================================================

import type { Connector, ConnectorExecutionResult, ConnectorStatus } from '../base';
import {
  escapeAppleScriptString,
  parseAppleScriptDate,
  runAppleScript,
  sharedAppleScriptHandlers,
} from './osascript';

interface MailAccountItem {
  name: string;
}

interface MailboxItem {
  account: string;
  name: string;
}

interface MailMessageSummary {
  id: number;
  account?: string;
  mailbox?: string;
  subject: string;
  sender: string;
  receivedAtMs: number | null;
  read: boolean;
}

interface MailMessageDetail extends MailMessageSummary {
  content: string;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

async function listAccounts(): Promise<MailAccountItem[]> {
  const output = await runAppleScript([
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
    'set outputLines to {}',
    'repeat with acc in every account',
    'set end of outputLines to my sanitizeText(name of acc)',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell',
  ]);

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

async function listMailboxes(payload: Record<string, unknown>): Promise<MailboxItem[]> {
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
    'set outputLines to {}',
  ];

  if (accountName) {
    lines.push(`set targetAccounts to {account "${escapeAppleScriptString(accountName)}"}`);
  } else {
    lines.push('set targetAccounts to every account');
  }

  lines.push(
    'repeat with acc in targetAccounts',
    'repeat with box in every mailbox of acc',
    'set end of outputLines to (my sanitizeText(name of acc)) & "|" & (my sanitizeText(name of box))',
    'end repeat',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [account, name] = parseLine(line);
      return { account, name };
    });
}

async function listMessages(payload: Record<string, unknown>): Promise<MailMessageSummary[]> {
  const mailboxName = typeof payload.mailbox === 'string' ? payload.mailbox.trim() : '';
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const query = typeof payload.query === 'string' ? payload.query.trim().toLowerCase() : '';
  const limit = typeof payload.limit === 'number' ? payload.limit : 10;
  const scanLimit = typeof payload.scan_limit === 'number'
    ? payload.scan_limit
    : Math.max(limit * (query ? 10 : 2), 25);

  if (!mailboxName) {
    throw new Error('mailbox is required for list_messages');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
  ];

  if (accountName) {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}" of account "${escapeAppleScriptString(accountName)}"`);
  } else {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}"`);
  }

  lines.push(
    'set msgRefs to messages of targetMailbox',
    'set msgCount to count of msgRefs',
    'set outputLines to {}',
    `set scanLimit to ${Math.max(1, Math.floor(scanLimit))}`,
    'repeat with idx from 1 to msgCount',
    'if idx > scanLimit then exit repeat',
    'set msgRef to item idx of msgRefs',
    'set msgLine to (id of msgRef as text) & "|" & (my sanitizeText(subject of msgRef)) & "|" & (my sanitizeText(sender of msgRef)) & "|" & (my sanitizeText((date received of msgRef) as text)) & "|" & (read status of msgRef as text)',
    'set end of outputLines to msgLine',
    'end repeat',
    'return my joinLines(outputLines)',
    'end tell'
  );

  const output = await runAppleScript(lines);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [idRaw, subject, sender, receivedRaw, readRaw] = parseLine(line);
      return {
        id: Number(idRaw),
        account: accountName || undefined,
        mailbox: mailboxName,
        subject,
        sender,
        receivedAtMs: parseAppleScriptDate(receivedRaw),
        read: readRaw === 'true',
      } satisfies MailMessageSummary;
    })
    .filter((item) => !query || item.subject.toLowerCase().includes(query) || item.sender.toLowerCase().includes(query))
    .slice(0, limit);
}

async function readMessage(payload: Record<string, unknown>): Promise<MailMessageDetail> {
  const mailboxName = typeof payload.mailbox === 'string' ? payload.mailbox.trim() : '';
  const accountName = typeof payload.account === 'string' ? payload.account.trim() : '';
  const messageId = typeof payload.message_id === 'number' ? payload.message_id : NaN;

  if (!mailboxName) {
    throw new Error('mailbox is required for read_message');
  }
  if (!Number.isFinite(messageId)) {
    throw new Error('message_id is required for read_message');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    'tell application "Mail"',
  ];

  if (accountName) {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}" of account "${escapeAppleScriptString(accountName)}"`);
  } else {
    lines.push(`set targetMailbox to mailbox "${escapeAppleScriptString(mailboxName)}"`);
  }

  lines.push(
    `set msgRef to first message of targetMailbox whose id is ${Math.floor(messageId)}`,
    'return (id of msgRef as text) & "|" & (my sanitizeText(subject of msgRef)) & "|" & (my sanitizeText(sender of msgRef)) & "|" & (my sanitizeText((date received of msgRef) as text)) & "|" & (read status of msgRef as text) & "|" & (my sanitizeText(content of msgRef))',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const [idRaw, subject, sender, receivedRaw, readRaw, content] = parseLine(output);
  return {
    id: Number(idRaw),
    account: accountName || undefined,
    mailbox: mailboxName,
    subject,
    sender,
    receivedAtMs: parseAppleScriptDate(receivedRaw),
    read: readRaw === 'true',
    content,
  };
}

export const mailConnector: Connector = {
  id: 'mail',
  label: 'Mail',
  capabilities: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message'],
  async getStatus(): Promise<ConnectorStatus> {
    try {
      const accounts = await listAccounts();
      return {
        connected: true,
        detail: `可访问 ${accounts.length} 个邮件账户`,
        capabilities: this.capabilities,
      };
    } catch (error) {
      return {
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
        capabilities: this.capabilities,
      };
    }
  },
  async execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult> {
    switch (action) {
      case 'get_status':
        return { data: await this.getStatus() };
      case 'list_accounts': {
        const accounts = await listAccounts();
        return {
          data: accounts,
          summary: accounts.length > 0 ? `找到 ${accounts.length} 个邮件账户` : '没有找到可访问的邮件账户',
        };
      }
      case 'list_mailboxes': {
        const mailboxes = await listMailboxes(payload);
        return {
          data: mailboxes,
          summary: mailboxes.length > 0 ? `找到 ${mailboxes.length} 个邮箱` : '没有找到可访问的邮箱',
        };
      }
      case 'list_messages': {
        const messages = await listMessages(payload);
        return {
          data: messages,
          summary: messages.length > 0 ? `找到 ${messages.length} 封邮件` : '没有找到匹配的邮件',
        };
      }
      case 'read_message': {
        const message = await readMessage(payload);
        return {
          data: message,
          summary: `读取邮件：${message.subject}`,
        };
      }
      default:
        throw new Error(`Unsupported mail action: ${action}`);
    }
  },
};
