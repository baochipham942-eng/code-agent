// ============================================================================
// MailSend (native ToolModule) Tests — P0-6.3 Batch 4
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

import { mailSendModule } from '../../../../../src/main/tools/modules/connectors/mailSend';

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
  const handler = await mailSendModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

const validArgs = { subject: 'Hi', to: ['a@x.com'] };

beforeEach(() => {
  execMock.mockReset();
  getMock.mockReset();
  getMock.mockReturnValue({ execute: execMock });
});

describe('mailSendModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(mailSendModule.schema.name).toBe('mail_send');
      expect(mailSendModule.schema.category).toBe('mcp');
      expect(mailSendModule.schema.permissionLevel).toBe('write');
      expect(mailSendModule.schema.readOnly).toBe(false);
      expect(mailSendModule.schema.allowInPlanMode).toBe(false);
      expect(mailSendModule.schema.inputSchema.required).toEqual(['subject', 'to']);
    });
  });

  describe('validation & errors', () => {
    it('rejects missing subject', async () => {
      const result = await run({ to: ['a@x.com'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty subject', async () => {
      const result = await run({ subject: '', to: ['a@x.com'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing to', async () => {
      const result = await run({ subject: 'Hi' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects empty to array', async () => {
      const result = await run({ subject: 'Hi', to: [] });
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
      execMock.mockRejectedValue(new Error('smtp down'));
      const result = await run(validArgs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Mail send failed: smtp down');
    });
  });

  describe('happy path', () => {
    it('formats minimal send result', async () => {
      execMock.mockResolvedValue({
        data: {
          subject: 'Hi',
          to: ['a@x.com'],
          cc: [],
          bcc: [],
          attachments: [],
          sent: true,
        },
      });
      const result = await run(validArgs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已发送邮件：Hi');
        expect(result.output).toContain('To: a@x.com');
        expect(result.output).not.toContain('CC:');
        expect(result.output).not.toContain('BCC:');
        expect(result.output).not.toContain('Attachments:');
      }
      expect(execMock).toHaveBeenCalledWith('send_message', validArgs);
    });

    it('formats full send result with cc/bcc/attachments', async () => {
      execMock.mockResolvedValue({
        data: {
          subject: 'Report',
          to: ['a@x.com', 'b@x.com'],
          cc: ['c@x.com'],
          bcc: ['d@x.com'],
          attachments: ['report.pdf'],
          sent: true,
        },
      });
      const result = await run({
        subject: 'Report',
        to: ['a@x.com', 'b@x.com'],
        cc: ['c@x.com'],
        bcc: ['d@x.com'],
        attachments: ['report.pdf'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('已发送邮件：Report');
        expect(result.output).toContain('To: a@x.com, b@x.com');
        expect(result.output).toContain('CC: c@x.com');
        expect(result.output).toContain('BCC: d@x.com');
        expect(result.output).toContain('Attachments: report.pdf');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting progress', async () => {
      execMock.mockResolvedValue({
        data: { subject: 'Hi', to: ['a@x.com'], cc: [], bcc: [], attachments: [], sent: true },
      });
      const onProgress = vi.fn();
      await run(validArgs, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
    });
  });
});
