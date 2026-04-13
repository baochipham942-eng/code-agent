// ============================================================================
// Mail (native ToolModule) Tests — P0-6.3 Batch 4
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

// -----------------------------------------------------------------------------
// Mock connector registry
// -----------------------------------------------------------------------------

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../../../src/main/connectors', () => ({
  getConnectorRegistry: () => ({
    get: getMock,
  }),
}));

import { mailModule } from '../../../../../src/main/tools/migrated/connectors/mail';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await mailModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('mailModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(mailModule.schema.name).toBe('mail');
      expect(mailModule.schema.category).toBe('mcp');
      expect(mailModule.schema.permissionLevel).toBe('read');
      expect(mailModule.schema.readOnly).toBe(true);
      expect(mailModule.schema.allowInPlanMode).toBe(true);
      expect(mailModule.schema.inputSchema.required).toEqual(['action']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing action', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects unknown action', async () => {
      const result = await run({ action: 'delete_all_messages' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ action: 'get_status' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ action: 'get_status' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when connector missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('wraps connector errors as FS-less failure', async () => {
      execMock.mockRejectedValue(new Error('boom'));
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Mail connector failed: boom');
    });
  });

  describe('actions happy path', () => {
    it('get_status formats connected status', async () => {
      execMock.mockResolvedValue({
        data: { connected: true, detail: 'OK', capabilities: ['read', 'send'] },
      });
      const result = await run({ action: 'get_status' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Mail connector: connected');
        expect(result.output).toContain('OK');
        expect(result.output).toContain('Capabilities: read, send');
      }
    });

    it('list_accounts formats account list', async () => {
      execMock.mockResolvedValue({
        data: [{ name: 'Work' }, { name: 'Personal' }],
      });
      const result = await run({ action: 'list_accounts' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('邮件账户 (2)');
        expect(result.output).toContain('- Work');
        expect(result.output).toContain('- Personal');
      }
    });

    it('list_accounts empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_accounts' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到可访问的邮件账户。');
    });

    it('list_mailboxes formats with account prefix', async () => {
      execMock.mockResolvedValue({
        data: [
          { account: 'Work', name: 'INBOX' },
          { account: 'Work', name: 'Sent' },
        ],
      });
      const result = await run({ action: 'list_mailboxes' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('邮箱列表 (2)');
        expect(result.output).toContain('- [Work] INBOX');
        expect(result.output).toContain('- [Work] Sent');
      }
    });

    it('list_mailboxes empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_mailboxes' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到可访问的邮箱。');
    });

    it('list_messages formats messages with read state', async () => {
      execMock.mockResolvedValue({
        data: [
          {
            id: 1,
            account: 'Work',
            mailbox: 'INBOX',
            subject: 'Hello',
            sender: 'a@x.com',
            receivedAtMs: Date.UTC(2026, 3, 13),
            read: true,
          },
          {
            id: 2,
            account: 'Work',
            mailbox: 'INBOX',
            subject: 'Unread',
            sender: 'b@x.com',
            receivedAtMs: null,
            read: false,
          },
        ],
      });
      const result = await run({ action: 'list_messages', mailbox: 'INBOX' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('邮件列表 (2)');
        expect(result.output).toContain('#1 Hello');
        expect(result.output).toContain('Work / INBOX');
        expect(result.output).toContain('| 已读');
        expect(result.output).toContain('#2 Unread');
        expect(result.output).toContain('未知时间');
        expect(result.output).toContain('| 未读');
      }
    });

    it('list_messages empty fallback', async () => {
      execMock.mockResolvedValue({ data: [] });
      const result = await run({ action: 'list_messages', mailbox: 'INBOX' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output).toBe('没有找到匹配的邮件。');
    });

    it('read_message formats with attachments', async () => {
      execMock.mockResolvedValue({
        data: {
          id: 42,
          subject: 'Report',
          sender: 'boss@x.com',
          receivedAtMs: Date.UTC(2026, 3, 13),
          read: false,
          content: 'Q1 numbers attached.',
          attachments: ['q1.pdf', 'q1.xlsx'],
        },
      });
      const result = await run({ action: 'read_message', message_id: 42 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('邮件 #42');
        expect(result.output).toContain('主题：Report');
        expect(result.output).toContain('发件人：boss@x.com');
        expect(result.output).toContain('状态：未读');
        expect(result.output).toContain('附件：2 个');
        expect(result.output).toContain('q1.pdf, q1.xlsx');
        expect(result.output).toContain('Q1 numbers attached.');
      }
    });

    it('read_message without attachments omits attachment line', async () => {
      execMock.mockResolvedValue({
        data: {
          id: 7,
          subject: 'Plain',
          sender: 'a@x.com',
          receivedAtMs: null,
          read: true,
          content: 'body',
        },
      });
      const result = await run({ action: 'read_message', message_id: 7 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('邮件 #7');
        expect(result.output).not.toContain('附件：');
        expect(result.output).toContain('状态：已读');
      }
    });

    it('read_message uses attachmentCount when attachments array absent', async () => {
      execMock.mockResolvedValue({
        data: {
          id: 9,
          subject: 'Counted',
          sender: 'a@x.com',
          receivedAtMs: null,
          read: true,
          content: 'body',
          attachmentCount: 5,
        },
      });
      const result = await run({ action: 'read_message', message_id: 9 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('附件：5 个');
        expect(result.output).not.toContain('(');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({ data: [] });
      const onProgress = vi.fn();
      await run({ action: 'list_accounts' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
