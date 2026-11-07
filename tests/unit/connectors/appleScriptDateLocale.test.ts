import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runAppleScript: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/host/connectors/native/osascript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/host/connectors/native/osascript')>();
  return { ...actual, runAppleScript: mocks.runAppleScript };
});

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
}));

import { mailConnector } from '../../../src/host/connectors/native/mail';
import { calendarConnector } from '../../../src/host/connectors/native/calendar';
import { remindersConnector } from '../../../src/host/connectors/native/reminders';

const EXPECTED = new Date(2026, 10, 3, 22, 15, 30).getTime();
const EXPECTED_NOON = new Date(2026, 10, 3, 12, 15, 30).getTime();
const EXPECTED_AM = new Date(2026, 10, 3, 10, 15, 30).getTime();

const FIXTURES: Array<[string, string, number]> = [
  ['Chinese weekday', '2026年11月3日 星期二 22:15:30', EXPECTED],
  ['Chinese no weekday', '2026年11月3日 22:15:30', EXPECTED],
  ['Chinese 下午', '2026年11月3日 星期二 下午10:15:30', EXPECTED],
  ['Chinese 上午', '2026年11月3日 上午10:15:30', EXPECTED_AM],
  ['Chinese 中午 noon', '2026年11月3日 星期二 中午12:15:30', EXPECTED_NOON],
  ['English 24h', 'Tuesday, November 3, 2026 at 22:15:30', EXPECTED],
  ['English PM', 'Tuesday, November 3, 2026 at 10:15:30 PM', EXPECTED],
  ['English AM', 'Tuesday, November 3, 2026 at 10:15:30 AM', EXPECTED_AM],
  ['ISO', '2026-11-03T22:15:30', EXPECTED],
];

beforeEach(() => {
  mocks.runAppleScript.mockReset();
  mocks.warn.mockReset();
});

describe.each(FIXTURES)('%s (%s)', (_name, raw, expected) => {
  it('mail list_messages / read_message', async () => {
    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true`);
    const list = await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    expect((list.data as Array<{ receivedAtMs: number | null }>)[0].receivedAtMs).toBe(expected);

    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true|body|0|`);
    const read = await mailConnector.execute('read_message', { mailbox: 'INBOX', message_id: 7 });
    expect((read.data as { receivedAtMs: number | null }).receivedAtMs).toBe(expected);
  });

  it('calendar list / get / create / update', async () => {
    const line = `u1|Work|Meet|${raw}|${raw}|Room|n|`;
    mocks.runAppleScript.mockResolvedValueOnce(line);
    const list = await calendarConnector.execute('list_events', {
      from_ms: EXPECTED - 86_400_000, to_ms: EXPECTED + 86_400_000,
    });
    const ev = (list.data as Array<{ startAtMs: number | null; endAtMs: number | null }>)[0];
    expect([ev.startAtMs, ev.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript.mockResolvedValueOnce(line);
    const got = (await calendarConnector.execute('get_event', { calendar: 'Work', event_uid: 'u1' })).data as typeof ev;
    expect([got.startAtMs, got.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript.mockResolvedValueOnce(`u1|Work|Meet|${raw}|${raw}|Room`);
    const created = (await calendarConnector.execute('create_event', {
      calendar: 'Work', title: 'Meet', start_ms: EXPECTED,
    })).data as typeof ev;
    expect([created.startAtMs, created.endAtMs]).toEqual([expected, expected]);

    mocks.runAppleScript.mockResolvedValueOnce(`u1|Work|Meet|${raw}|${raw}|Room`);
    const updated = (await calendarConnector.execute('update_event', {
      calendar: 'Work', event_uid: 'u1', title: 'Meet',
    })).data as typeof ev;
    expect([updated.startAtMs, updated.endAtMs]).toEqual([expected, expected]);
  });

  it('reminders list / get', async () => {
    mocks.runAppleScript.mockResolvedValueOnce(`r1|Home|Buy|false|note|${raw}`);
    const list = await remindersConnector.execute('list_reminders', {});
    expect((list.data as Array<{ remindAtMs: number | null }>)[0].remindAtMs).toBe(expected);

    mocks.runAppleScript.mockResolvedValueOnce(`r1|Home|Buy|false|note|${raw}`);
    const got = await remindersConnector.execute('get_reminder', { list: 'Home', reminder_id: 'r1' });
    expect((got.data as { remindAtMs: number | null }).remindAtMs).toBe(expected);
  });
});

describe('degenerate dates', () => {
  it('empty string stays null without warning', async () => {
    mocks.runAppleScript.mockResolvedValueOnce('r1|Home|Buy|false|note|');
    const list = await remindersConnector.execute('list_reminders', {});
    expect((list.data as Array<{ remindAtMs: number | null }>)[0].remindAtMs).toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('unparseable non-empty string warns with the raw text and returns null', async () => {
    const raw = '3 novembre 2026 à 22:15:30';
    mocks.runAppleScript.mockResolvedValueOnce(`7|Hi|a@x.com|${raw}|true`);
    const list = await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    expect((list.data as Array<{ receivedAtMs: number | null }>)[0].receivedAtMs).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls[0])).toContain(raw);
  });
});

describe('locale-independent fetch scripts', () => {
  it('scripts use isoDateText with the shared handler instead of "as text" dates', async () => {
    const scripts: string[] = [];
    mocks.runAppleScript.mockImplementation(async (lines: string[]) => {
      scripts.push(lines.join('\n'));
      return '';
    });
    await mailConnector.execute('list_messages', { mailbox: 'INBOX' });
    await mailConnector.execute('read_message', { mailbox: 'INBOX', message_id: 1 }).catch(() => undefined);
    await calendarConnector.execute('list_events', {});
    await calendarConnector.execute('get_event', { calendar: 'W', event_uid: 'u' }).catch(() => undefined);
    await calendarConnector.execute('create_event', { calendar: 'W', title: 't', start_ms: 1 }).catch(() => undefined);
    await calendarConnector.execute('update_event', { calendar: 'W', event_uid: 'u', title: 't' }).catch(() => undefined);
    await remindersConnector.execute('list_reminders', {});
    await remindersConnector.execute('get_reminder', { list: 'L', reminder_id: 'r' }).catch(() => undefined);
    expect(scripts).toHaveLength(8);
    for (const script of scripts) {
      expect(script).toContain('on isoDateText(d)');
      expect(script).toMatch(/my isoDateText\(/);
      expect(script).not.toMatch(/(date received|start date|end date)[^)]*\) as text/);
      expect(script).not.toMatch(/sanitizeText\(rawRemindDate\)/);
    }
  });
});
