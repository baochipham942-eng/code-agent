// ============================================================================
// Native Mail Connector - macOS Mail via AppleScript
// ============================================================================

import fs from 'fs';
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
  attachments?: string[];
  attachmentCount?: number;
}

interface MailDraftItem {
  subject: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: string[];
  saved: boolean;
}

interface MailSentItem extends MailDraftItem {
  sent: boolean;
}

function parseLine(line: string): string[] {
  return line.split('|').map((part) => part.trim());
}

function normalizeAddressList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function appleScriptAddressList(addresses: string[]): string {
  return `{${addresses.map((item) => `"${escapeAppleScriptString(item)}"`).join(', ')}}`;
}

function normalizeAttachmentList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseAttachmentNames(value: string): string[] {
  return value
    .split(/\s*;\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
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
    'set attachmentNames to {}',
    'try',
    'repeat with attachmentItem in mail attachments of msgRef',
    'set end of attachmentNames to my sanitizeText(name of attachmentItem)',
    'end repeat',
    'end try',
    'set {oldTID, AppleScript\'s text item delimiters} to {AppleScript\'s text item delimiters, "; "}',
    'set attachmentText to attachmentNames as text',
    'set AppleScript\'s text item delimiters to oldTID',
    'return (id of msgRef as text) & "|" & (my sanitizeText(subject of msgRef)) & "|" & (my sanitizeText(sender of msgRef)) & "|" & (my sanitizeText((date received of msgRef) as text)) & "|" & (read status of msgRef as text) & "|" & (my sanitizeText(content of msgRef)) & "|" & (count of attachmentNames as text) & "|" & (my sanitizeText(attachmentText))',
    'end tell'
  );

  const output = await runAppleScript(lines);
  const [idRaw, subject, sender, receivedRaw, readRaw, content, attachmentCountRaw, attachmentNamesRaw] = parseLine(output);
  const attachmentCount = Number(attachmentCountRaw);
  const attachments = parseAttachmentNames(attachmentNamesRaw || '');
  return {
    id: Number(idRaw),
    account: accountName || undefined,
    mailbox: mailboxName,
    subject,
    sender,
    receivedAtMs: parseAppleScriptDate(receivedRaw),
    read: readRaw === 'true',
    content,
    attachmentCount: Number.isFinite(attachmentCount) ? attachmentCount : attachments.length,
    attachments,
  };
}

async function draftMessage(payload: Record<string, unknown>): Promise<MailDraftItem> {
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const attachments = normalizeAttachmentList(payload.attachments)
    .filter((item) => fs.existsSync(item));

  if (!subject) {
    throw new Error('subject is required for draft_message');
  }
  if (to.length === 0) {
    throw new Error('to is required for draft_message');
  }

  const lines = [
    ...sharedAppleScriptHandlers(),
    `set toAddresses to ${appleScriptAddressList(to)}`,
    `set ccAddresses to ${appleScriptAddressList(cc)}`,
    `set bccAddresses to ${appleScriptAddressList(bcc)}`,
    `set attachmentPaths to ${appleScriptAddressList(attachments)}`,
    'tell application "Mail"',
    `set newMessage to make new outgoing message with properties {visible:false, subject:"${escapeAppleScriptString(subject)}", content:"${escapeAppleScriptString(content)}"}`,
    'tell newMessage',
    'repeat with addr in toAddresses',
    'make new to recipient at end of to recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in ccAddresses',
    'make new cc recipient at end of cc recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in bccAddresses',
    'make new bcc recipient at end of bcc recipients with properties {address:addr}',
    'end repeat',
    'repeat with attachmentPath in attachmentPaths',
    'make new attachment with properties {file name:(POSIX file attachmentPath as alias)} at after the last paragraph',
    'end repeat',
    'save',
    'end tell',
    'return my sanitizeText(subject of newMessage)',
    'end tell',
  ];

  const output = await runAppleScript(lines);
  return {
    subject: output || subject,
    to,
    cc,
    bcc,
    attachments,
    saved: true,
  };
}

async function sendMessage(payload: Record<string, unknown>): Promise<MailSentItem> {
  const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
  const content = typeof payload.content === 'string' ? payload.content : '';
  const to = normalizeAddressList(payload.to);
  const cc = normalizeAddressList(payload.cc);
  const bcc = normalizeAddressList(payload.bcc);
  const attachments = normalizeAttachmentList(payload.attachments)
    .filter((item) => fs.existsSync(item));

  if (!subject) {
    throw new Error('subject is required for send_message');
  }
  if (to.length === 0) {
    throw new Error('to is required for send_message');
  }

  await runAppleScript([
    ...sharedAppleScriptHandlers(),
    `set toAddresses to ${appleScriptAddressList(to)}`,
    `set ccAddresses to ${appleScriptAddressList(cc)}`,
    `set bccAddresses to ${appleScriptAddressList(bcc)}`,
    `set attachmentPaths to ${appleScriptAddressList(attachments)}`,
    'tell application "Mail"',
    `set newMessage to make new outgoing message with properties {visible:false, subject:"${escapeAppleScriptString(subject)}", content:"${escapeAppleScriptString(content)}"}`,
    'tell newMessage',
    'repeat with addr in toAddresses',
    'make new to recipient at end of to recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in ccAddresses',
    'make new cc recipient at end of cc recipients with properties {address:addr}',
    'end repeat',
    'repeat with addr in bccAddresses',
    'make new bcc recipient at end of bcc recipients with properties {address:addr}',
    'end repeat',
    'repeat with attachmentPath in attachmentPaths',
    'make new attachment with properties {file name:(POSIX file attachmentPath as alias)} at after the last paragraph',
    'end repeat',
    'send',
    'end tell',
    'end tell',
  ]);

  return {
    subject,
    to,
    cc,
    bcc,
    attachments,
    saved: false,
    sent: true,
  };
}

export const mailConnector: Connector = {
  id: 'mail',
  label: 'Mail',
  capabilities: ['get_status', 'list_accounts', 'list_mailboxes', 'list_messages', 'read_message', 'draft_message', 'send_message'],
  async getStatus(): Promise<ConnectorStatus> {
    // Keep startup status checks side-effect free. Enumerating Mail accounts via
    // AppleScript will auto-launch Mail, so the real probe moves to first use.
    return {
      connected: process.platform === 'darwin',
      detail: process.platform === 'darwin'
        ? '按需访问本地 Mail；为避免启动时拉起 Mail，账户探测改为首轮使用时执行。'
        : 'Mail connector 仅在 macOS 可用。',
      capabilities: this.capabilities,
    };
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
      case 'draft_message': {
        const draft = await draftMessage(payload);
        return {
          data: draft,
          summary: `已创建邮件草稿：${draft.subject}`,
        };
      }
      case 'send_message': {
        const message = await sendMessage(payload);
        return {
          data: message,
          summary: `已发送邮件：${message.subject}`,
        };
      }
      default:
        throw new Error(`Unsupported mail action: ${action}`);
    }
  },
};
