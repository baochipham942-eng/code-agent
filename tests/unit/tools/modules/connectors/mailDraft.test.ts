// ============================================================================
// MailDraft (native ToolModule) Tests — P0-6.3 Batch 4
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const execMock = vi.fn();
const getMock = vi.fn();

vi.mock('../../../../../src/main/connectors', () => ({
  getConnectorRegistry: () => ({
    get: getMock,
  }),
}));

import { mailDraftModule } from '../../../../../src/main/tools/modules/connectors/mailDraft';

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
  const handler = await mailDraftModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const validArgs = { subject: 'Draft', to: ['a@x.com'] };

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('mailDraftModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(mailDraftModule.schema.name).toBe('mail_draft');
      expect(mailDraftModule.schema.category).toBe('mcp');
      expect(mailDraftModule.schema.permissionLevel).toBe('write');
      expect(mailDraftModule.schema.readOnly).toBe(false);
      expect(mailDraftModule.schema.allowInPlanMode).toBe(false);
      expect(mailDraftModule.schema.inputSchema.required).toEqual(['subject', 'to']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing subject', async () => {
      const result = await run({ to: ['a@x.com'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing to', async () => {
      const result = await run({ subject: 'Draft' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty to array', async () => {
      const result = await run({ subject: 'Draft', to: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(validArgs, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run(validArgs, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when connector missing', async () => {
      getMock.mockReturnValue(undefined);
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('wraps connector errors', async () => {
      execMock.mockRejectedValue(new Error('mail locked'));
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Mail draft failed: mail locked');
    });
  });

  describe('happy path', () => {
    it('formats minimal saved draft', async () => {
      execMock.mockResolvedValue({
        data: {
          subject: 'Draft',
          to: ['a@x.com'],
          cc: [],
          bcc: [],
          attachments: [],
          saved: true,
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已创建邮件草稿：Draft');
        expect(result.output).toContain('To: a@x.com');
        expect(result.output).toContain('状态：已保存到草稿');
        expect(result.output).not.toContain('CC:');
      }
      expect(execMock).toHaveBeenCalledWith('draft_message', validArgs);
    });

    it('formats full draft with cc/bcc/attachments', async () => {
      execMock.mockResolvedValue({
        data: {
          subject: 'Big',
          to: ['a@x.com'],
          cc: ['c@x.com'],
          bcc: ['d@x.com'],
          attachments: ['doc.pdf'],
          saved: true,
        },
      });
      const result = await run({
        subject: 'Big',
        to: ['a@x.com'],
        cc: ['c@x.com'],
        bcc: ['d@x.com'],
        attachments: ['doc.pdf'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('CC: c@x.com');
        expect(result.output).toContain('BCC: d@x.com');
        expect(result.output).toContain('Attachments: doc.pdf');
        expect(result.output).toContain('状态：已保存到草稿');
      }
    });

    it('normalizes string address into array', async () => {
      execMock.mockResolvedValue({
        data: {
          subject: 'S',
          to: 'a@x.com, b@x.com;c@x.com',
          cc: [],
          bcc: [],
          attachments: [],
          saved: false,
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('To: a@x.com, b@x.com, c@x.com');
        expect(result.output).toContain('状态：未保存');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({
        data: { subject: 'D', to: ['a@x.com'], cc: [], bcc: [], attachments: [], saved: true },
      });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
