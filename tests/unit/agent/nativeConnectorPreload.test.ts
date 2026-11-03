import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  enabledNative: [] as string[],
  runAppleScript: vi.fn(async () => 'Work\nPersonal'),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }),
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({ connectors: { enabledNative: mocks.enabledNative } }) }),
}));

// 只在 osascript 边界替身：连接器对象、registry、tool-search 都是真实的。
vi.mock('../../../src/host/connectors/native/osascript', () => ({
  runAppleScript: mocks.runAppleScript,
  escapeAppleScriptString: (value: string) => value,
  parseAppleScriptDate: () => null,
  buildAppleScriptDateVar: () => [],
  sharedAppleScriptHandlers: () => [],
}));

import {
  getDeferredToolsToPreloadForTurn,
  preloadDeferredToolsForTurn,
} from '../../../src/host/agent/runtime/contextAssembly/deferredToolPreload';
import { TurnState } from '../../../src/host/agent/runtime/turnState';
import { getConnectorRegistry } from '../../../src/host/connectors/registry';
import { resetToolSearchService } from '../../../src/host/services/toolSearch';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import type { ToolModule } from '../../../src/host/protocol/tools';
import { remindersCreateSchema } from '../../../src/host/tools/modules/connectors/remindersCreate.schema';
import { mailDraftSchema } from '../../../src/host/tools/modules/connectors/mailDraft.schema';
import { calendarCreateEventSchema } from '../../../src/host/tools/modules/connectors/calendarCreateEvent.schema';

const ALL = ['reminders', 'mail', 'calendar'];
const PROMPT = '帮我加一个明天的提醒，再起草一封邮件草稿，再建一个日历日程';

function turn(content: string, toolScope?: { allowedConnectorIds?: string[] }) {
  return {
    enableToolDeferredLoading: true,
    executionIntent: undefined,
    messages: [{ id: 'm1', role: 'user' as const, content, timestamp: 1 }],
    turn: TurnState.forTest(),
    toolScope,
  };
}

function enable(ids: string[]): void {
  mocks.enabledNative = ids;
  getConnectorRegistry().configure(ids);
}

const darwin = process.platform === 'darwin';

describe.skipIf(!darwin)('native connector preload from enabledNative', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    resetProtocolRegistry();
    for (const schema of [remindersCreateSchema, mailDraftSchema, calendarCreateEventSchema]) {
      const module: ToolModule = {
        schema,
        createHandler: () => ({ schema, async execute() { return { ok: true, output: null }; } }),
      };
      getProtocolRegistry().register(schema, async () => module);
    }
    resetToolSearchService();
    enable([]);
  });

  it('enabled + ready: write tools are preloaded without a composer selection', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT));
    expect(names).toEqual(expect.arrayContaining(['reminders_create', 'mail_draft', 'calendar_create_event']));
    expect(mocks.warn).not.toHaveBeenCalled();

    const loaded = preloadDeferredToolsForTurn(turn(PROMPT));
    expect(loaded).toEqual(expect.arrayContaining(['reminders_create', 'mail_draft', 'calendar_create_event']));
  });

  it('enabled but unchecked (post-restart): not preloaded, warns with the readiness reason', () => {
    enable(ALL);

    expect(getDeferredToolsToPreloadForTurn(turn(PROMPT))).toEqual([]);
    const warns = mocks.warn.mock.calls.map((call) => String(call[0]));
    expect(warns.some((w) => w.includes('reason: readiness-unchecked') && w.includes('reminders'))).toBe(true);
  });

  it('enabled in config but absent from the registry: warns with not-registered', () => {
    mocks.enabledNative = ['reminders'];
    getConnectorRegistry().configure([]);

    expect(getDeferredToolsToPreloadForTurn(turn('加个提醒'))).toEqual([]);
    const warns = mocks.warn.mock.calls.map((call) => String(call[0]));
    expect(warns.some((w) => w.includes('reason: not-registered'))).toBe(true);
  });

  it('not enabled: nothing preloaded, no warn', () => {
    enable([]);

    expect(getDeferredToolsToPreloadForTurn(turn(PROMPT))).toEqual([]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('enabled + ready but the prompt has no reminder/mail/calendar wording: not preloaded', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    expect(getDeferredToolsToPreloadForTurn(turn('帮我重构这个函数'))).toEqual([]);
  });

  it('respects an explicit composer selection of a different connector', async () => {
    enable(ALL);
    for (const id of ALL) await getConnectorRegistry().get(id)!.execute('probe_access', {});

    const names = getDeferredToolsToPreloadForTurn(turn(PROMPT, { allowedConnectorIds: ['feishu'] }));
    expect(names).not.toContain('reminders_create');
  });
});
