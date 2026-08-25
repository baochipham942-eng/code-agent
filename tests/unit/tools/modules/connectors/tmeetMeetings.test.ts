import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const executeMock = vi.hoisted(() => vi.fn());

vi.mock('../../../../../src/host/tools/modules/connectors/tmeetToolCli', () => ({
  executeTmeetCommand: executeMock,
}));

import { tmeetMeetingListModule } from '../../../../../src/host/tools/modules/connectors/tmeetMeetingList';
import { tmeetMeetingCreateModule } from '../../../../../src/host/tools/modules/connectors/tmeetMeetingCreate';
import { tmeetMeetingSearchModule } from '../../../../../src/host/tools/modules/connectors/tmeetMeetingSearch';

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
  vi.useRealTimers();
  executeMock.mockReset();
});

describe('tmeet meeting tools', () => {
  it('registers list as read-only and create behind the write permission level', () => {
    expect(tmeetMeetingListModule.schema).toMatchObject({
      name: 'tmeetMeetingList',
      permissionLevel: 'read',
      readOnly: true,
    });
    expect(tmeetMeetingSearchModule.schema).toMatchObject({
      name: 'tmeetMeetingSearch',
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
        artifact: {
          role: 'receipt',
          preview: '没有待开始/进行中的会议',
          metadata: { connector: 'tmeet', action: 'meeting.list', scope: 'upcoming' },
        },
      },
    });
  });

  it('uses list-ended and adds a rolling 30-day start when historical scope omits start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T14:30:00.000Z'));
    executeMock.mockResolvedValue(JSON.stringify({ data: { meeting_info_list: [] } }));
    const handler = await tmeetMeetingListModule.createHandler();

    const result = await handler.execute({ scope: 'ended', page_size: 30 }, makeContext(), allowAll);

    expect(executeMock).toHaveBeenCalledWith([
      'meeting', 'list-ended',
      '--start', '2026-07-26T14:30:00.000Z',
      '--page-size', '30',
      '--compact',
      '--format', 'json',
    ], 'tmeet meeting list-ended');
    expect(result).toMatchObject({
      ok: true,
      meta: {
        action: 'meeting.list-ended',
        scope: 'ended',
        effectiveStart: '2026-07-26T14:30:00.000Z',
        artifact: { preview: '近 30 天没有已结束的会议' },
      },
    });
  });

  it('keeps raw meeting JSON in output/meta and renders a human receipt one meeting per line', async () => {
    const response = {
      data: {
        meeting_info_list: [
          {
            subject: '产品周会',
            start_time: '2026-08-25T18:04:32+08:00',
            end_time: '2026-08-25T19:04:32+08:00',
          },
          {
            subject: '复盘会',
            scheduled_start_time: '2026-08-24T11:56:20+08:00',
            scheduled_end_time: '2026-08-24T12:56:20+08:00',
            creator_name: '林同学',
          },
        ],
      },
    };
    const raw = JSON.stringify(response);
    executeMock.mockResolvedValue(raw);
    const handler = await tmeetMeetingListModule.createHandler();

    const result = await handler.execute({ scope: 'ended', start: '2026-08-01T00:00:00+08:00' }, makeContext(), allowAll);

    expect(result).toMatchObject({
      ok: true,
      output: raw,
      meta: {
        response,
        artifact: {
          preview: [
            '2 场会议：',
            '- 产品周会｜2026-08-25 18:04 至 2026-08-25 19:04｜发起人：未知',
            '- 复盘会｜2026-08-24 11:56 至 2026-08-24 12:56｜发起人：林同学',
          ].join('\n'),
        },
      },
    });
    expect((result.meta?.artifact as { preview?: string }).preview).not.toContain('{"data"');
  });

  it('returns a human failed receipt when listing meetings fails', async () => {
    executeMock.mockRejectedValue(new Error('user config is empty'));
    const handler = await tmeetMeetingListModule.createHandler();

    const result = await handler.execute({ scope: 'ended', start: '2026-08-01T00:00:00+08:00' }, makeContext(), allowAll);

    expect(result).toMatchObject({
      ok: false,
      meta: {
        action: 'meeting.list-ended',
        artifact: {
          name: '查询已结束的腾讯会议失败',
          preview: expect.stringContaining('查询已结束的腾讯会议失败'),
          metadata: { connector: 'tmeet', scope: 'ended', success: false },
        },
      },
    });
  });

  it('rejects an invalid list page size before invoking the CLI', async () => {
    const handler = await tmeetMeetingListModule.createHandler();
    const result = await handler.execute({ page_size: 21 }, makeContext(), allowAll);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('assembles meeting search keyword, code, time window, and pagination flags', async () => {
    executeMock.mockResolvedValue(JSON.stringify({ data: { meetings: [] } }));
    const handler = await tmeetMeetingSearchModule.createHandler();

    const result = await handler.execute({
      query: '产品周会',
      query_field: 'subject',
      meeting_code: '123456789',
      start: '2026-08-01T00:00:00+08:00',
      end: '2026-08-25T23:59:59+08:00',
      page_token: 'next-page',
      page_size: 30,
    }, makeContext(), allowAll);

    expect(executeMock).toHaveBeenCalledWith([
      'meeting', 'search',
      '--query', '产品周会',
      '--query-field', 'subject',
      '--meeting-code', '123456789',
      '--start', '2026-08-01T00:00:00+08:00',
      '--end', '2026-08-25T23:59:59+08:00',
      '--page-token', 'next-page',
      '--page-size', '30',
      '--compact',
      '--format', 'json',
    ], 'tmeet meeting search');
    expect(result).toMatchObject({
      ok: true,
      meta: {
        action: 'meeting.search',
        artifact: { preview: '没有找到匹配的会议' },
      },
    });
  });

  it('rejects a dashed meeting code before invoking search', async () => {
    const handler = await tmeetMeetingSearchModule.createHandler();
    const result = await handler.execute({ meeting_code: '123-456' }, makeContext(), allowAll);

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
