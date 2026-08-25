import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const executeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/host/tools/modules/connectors/tmeetToolCli', () => ({
  executeTmeetCommand: executeMock,
}));

import { tmeetMeetingListModule } from '../../../../../src/host/tools/modules/connectors/tmeetMeetingList';
import { tmeetMeetingCreateModule } from '../../../../../src/host/tools/modules/connectors/tmeetMeetingCreate';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeContext(): ToolContext {
  return {
    sessionId: 'tmeet-test-session',
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

beforeEach(() => {
  executeMock.mockReset();
});

describe('tmeet meeting tools', () => {
  it('registers list as read-only and create behind the write permission level', () => {
    expect(tmeetMeetingListModule.schema).toMatchObject({
      name: 'tmeetMeetingList',
      permissionLevel: 'read',
      readOnly: true,
    });
    expect(tmeetMeetingCreateModule.schema).toMatchObject({
      name: 'tmeetMeetingCreate',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: false,
    });
  });

  it('calls meeting list with verified flags and returns a tmeet receipt artifact', async () => {
    executeMock.mockResolvedValue(JSON.stringify({ trace_id: 'trace', data: { meeting_info_list: [] } }));
    const handler = await tmeetMeetingListModule.createHandler();

    const result = await handler.execute({
      start: '2026-08-25T00:00:00+08:00',
      end: '2026-08-25T23:59:59+08:00',
      show_all_sub: 1,
      page_size: 20,
    }, makeContext(), allowAll);

    expect(executeMock).toHaveBeenCalledWith([
      'meeting', 'list',
      '--start', '2026-08-25T00:00:00+08:00',
      '--end', '2026-08-25T23:59:59+08:00',
      '--show-all-sub', '1',
      '--page-size', '20',
      '--compact',
      '--format', 'json',
    ], 'tmeet meeting list');
    expect(result).toMatchObject({
      ok: true,
      meta: {
        connector: 'tmeet',
        artifact: { role: 'receipt', metadata: { connector: 'tmeet', action: 'meeting.list' } },
      },
    });
  });

  it('rejects an invalid list page size before invoking the CLI', async () => {
    const handler = await tmeetMeetingListModule.createHandler();
    const result = await handler.execute({ page_size: 21 }, makeContext(), allowAll);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does not create a meeting when the write permission gate denies it', async () => {
    const handler = await tmeetMeetingCreateModule.createHandler();
    const result = await handler.execute({
      subject: 'Product sync',
      start: '2026-08-26T10:00:00+08:00',
      end: '2026-08-26T10:30:00+08:00',
    }, makeContext(), denyAll);

    expect(result).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('rejects the undocumented join type zero before invoking the CLI', async () => {
    const handler = await tmeetMeetingCreateModule.createHandler();
    const result = await handler.execute({
      subject: 'Product sync',
      start: '2026-08-26T10:00:00+08:00',
      end: '2026-08-26T10:30:00+08:00',
      join_type: 0,
    }, makeContext(), allowAll);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('creates a meeting with documented flags and returns a receipt artifact', async () => {
    executeMock.mockResolvedValue(JSON.stringify({
      trace_id: 'trace',
      data: { meeting_info_list: [{ meeting_code: '123456789' }] },
    }));
    const handler = await tmeetMeetingCreateModule.createHandler();
    const result = await handler.execute({
      subject: 'Product sync',
      start: '2026-08-26T10:00:00+08:00',
      end: '2026-08-26T10:30:00+08:00',
      timezone: 'Asia/Shanghai',
      join_type: 2,
      waiting_room: true,
      invitees: ['open_1', 'open_2'],
      audio_watermark: false,
      auto_asr: false,
    }, makeContext(), allowAll);

    expect(executeMock).toHaveBeenCalledWith([
      'meeting', 'create',
      '--subject', 'Product sync',
      '--start', '2026-08-26T10:00:00+08:00',
      '--end', '2026-08-26T10:30:00+08:00',
      '--timezone', 'Asia/Shanghai',
      '--join-type', '2',
      '--waiting-room',
      '--invitees', 'open_1,open_2',
      '--audio-watermark=false',
      '--auto-asr=false',
      '--format', 'json',
    ], 'tmeet meeting create');
    expect(result).toMatchObject({
      ok: true,
      meta: {
        connector: 'tmeet',
        artifact: { role: 'receipt', metadata: { connector: 'tmeet', action: 'meeting.create' } },
      },
    });
  });

  it('returns a failed tmeet receipt when create fails', async () => {
    executeMock.mockRejectedValue(new Error('user config is empty'));
    const handler = await tmeetMeetingCreateModule.createHandler();
    const result = await handler.execute({
      subject: 'Product sync',
      start: '2026-08-26T10:00:00+08:00',
      end: '2026-08-26T10:30:00+08:00',
    }, makeContext(), allowAll);

    expect(result).toMatchObject({
      ok: false,
      meta: {
        connector: 'tmeet',
        artifact: {
          role: 'receipt',
          metadata: { connector: 'tmeet', success: false },
        },
      },
    });
  });
});
