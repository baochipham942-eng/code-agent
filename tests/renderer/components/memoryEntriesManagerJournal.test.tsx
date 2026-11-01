// ============================================================================
// MemoryEntriesManager — 来源会话跳转 + 变更历史 + 后台写入标记
// （N-MEM-JOURNAL-SOURCEJUMP ② ③）
// ============================================================================
// ② 有来源会话 → 可点跳转（带 messageId 落点消息）；会话没了 → 禁用 + 原因
// ③ 详情展示最近变更日志行；最近一次是后台 actor 的条目在列表里带标记
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MemoryChangeJournalResult,
  MemoryChangeJournalRow,
  MemoryEntry,
  MemoryEntryListResult,
  MemoryEntryUpdateResult,
} from '../../../src/shared/contract/memory';
import { parseMemoryJournalSnapshot } from '../../../src/renderer/components/features/settings/tabs/memoryJournalSnapshot';

const invokeDomainMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { isAvailable: () => false, invokeDomain: invokeDomainMock },
}));

const switchSessionMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign(vi.fn(), { getState: () => ({ switchSession: switchSessionMock }) }),
}));

const setPendingSearchJumpMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/stores/sessionUIStore', () => ({
  useSessionUIStore: Object.assign(vi.fn(), { getState: () => ({ setPendingSearchJump: setPendingSearchJumpMock }) }),
}));

const setShowSettingsMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/renderer/stores/appStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/renderer/stores/appStore')>();
  return {
    ...actual,
    // 组件只走 getState().setShowSettings；hook 形态（useI18n 的 language/setLanguage/
    // cloudUIStrings）给最小真形状，别让 i18n 在渲染期解构 undefined。
    useAppStore: Object.assign(
      vi.fn(() => ({ language: 'zh', setLanguage: vi.fn(), cloudUIStrings: {} })),
      { getState: () => ({ setShowSettings: setShowSettingsMock }) },
    ),
  };
});

import { MemoryEntriesManager } from '../../../src/renderer/components/features/settings/tabs/MemoryEntriesManager';

const now = Date.parse('2026-10-31T08:00:00.000Z');

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_entry_1',
    schemaVersion: 2,
    status: 'active',
    kind: 'user',
    scope: 'global',
    title: 'User prefers dark mode',
    summary: 'Dark mode preference',
    content: 'The user prefers dark mode.',
    source: { kind: 'light_file', sourceOfTruth: 'light_file', filePath: 'user.md' },
    evidence: [],
    sessionId: null,
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function journalResult(rows: MemoryChangeJournalResult['rows']): MemoryChangeJournalResult {
  return { rows };
}

/** route invokeDomain：MEMORY 动作 + SESSION 存在性探测（只读 sessionExists，load 一律 unexpected） */
function mockBackend(options: {
  entries: MemoryEntry[];
  journal?: MemoryChangeJournalResult['rows'];
  sessionExists?: boolean | 'throw';
  /** memoryEntryUpdate 的返回形状：ok 走成功路径；fail 抛错（走恢复失败路径） */
  updateResult?: 'ok' | 'fail';
}): void {
  invokeDomainMock.mockImplementation(async (domain: string, action: string) => {
    if (domain === 'domain:session' && action === 'sessionExists') {
      if (options.sessionExists === 'throw') throw new Error('probe exploded');
      return options.sessionExists === true;
    }
    if (action === 'memoryEntries') {
      return { entries: options.entries, sourceCounts: { light_file: options.entries.length, db_memory: 0 } } satisfies MemoryEntryListResult;
    }
    if (action === 'memoryEntryJournal') return journalResult(options.journal ?? []);
    if (action === 'memoryEntryUpdate') {
      if (options.updateResult === 'fail') throw new Error('Memory entry not found: mem_entry_1');
      return { entry: options.entries[0] } satisfies MemoryEntryUpdateResult;
    }
    throw new Error(`unexpected invoke ${domain}/${action}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('MemoryEntriesManager — source session jump (②)', () => {
  it('opens the existing source session and lands on the message when a message id exists', async () => {
    mockBackend({
      entries: [entry({
        sessionId: 'sess-live',
        evidence: [{ sessionId: 'sess-live', messageId: 'msg-123456789' }],
      })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setPendingSearchJumpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-live',
      messageId: 'msg-123456789',
    }));
  });

  it('lands on the message even when the evidence sessionId was redacted by the sensitive guard (r3)', async () => {
    // 真实链路：evidence[].sessionId 落库时被 guardMemoryMetadata 统一 redact，
    // 顶层 sessionId（记录列）不经过 metadata 才保留原值—— messageId 匹配不能依赖 evidence 的 sessionId。
    mockBackend({
      entries: [entry({
        sessionId: 'sess-live',
        evidence: [{ sessionId: '***REDACTED***', messageId: 'msg-1' }],
      })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setPendingSearchJumpMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-live',
      messageId: 'msg-1',
    }));
  });

  it('closes the settings overlay on jump — switchSession does not close it (r5)', async () => {
    // 设置是 overlay：secondaryPages.ts 的 SECONDARY_PAGE_SHOW_EXCLUSIONS 明确不含
    // showSettings，switchSession 的 closeSecondaryPages 关不掉它——跳转后用户仍被
    // 设置页盖住，看不见落点。必须显式走 setShowSettings(false)（inviteExpert /
    // startCreateRoleChat 等设置内跳聊天同款）。
    mockBackend({
      entries: [entry({ sessionId: 'sess-live' })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openButton);

    await waitFor(() => expect(switchSessionMock).toHaveBeenCalledWith('sess-live'));
    expect(setShowSettingsMock).toHaveBeenCalledWith(false);
  });

  it('probes existence via the read-only sessionExists action and never calls the side-effectful load (r4)', async () => {
    // session.load 会 restoreSession：切宿主 currentSessionId/toolCache、清会话缓存、写审计。
    // 选中条目只是探测存在性，绝不能付这些副作用（rework r4）。
    mockBackend({
      entries: [entry({ sessionId: 'sess-live' })],
      sessionExists: true,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(false);
    const sessionCalls = invokeDomainMock.mock.calls.filter(([domain]) => domain === 'domain:session');
    expect(sessionCalls).toEqual([['domain:session', 'sessionExists', { sessionId: 'sess-live' }]]);
    expect(sessionCalls.some(([, action]) => action === 'load')).toBe(false);
  });

  it('disables the jump with a reason when the source session no longer exists', async () => {
    mockBackend({
      entries: [entry({ sessionId: 'sess-gone' })],
      sessionExists: false,
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-source-session-reason').textContent).toContain('来源会话已不存在');
    // 禁用态点不动
    fireEvent.click(openButton);
    expect(switchSessionMock).not.toHaveBeenCalled();
  });

  it('shows the probe-failure reason when existence cannot be confirmed', async () => {
    mockBackend({
      entries: [entry({ sessionId: 'sess-unknown' })],
      sessionExists: 'throw',
    });
    render(<MemoryEntriesManager />);

    const openButton = await screen.findByTestId('memory-entry-source-session-open');
    expect((openButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-source-session-reason').textContent).toContain('无法确认来源会话');
  });

  it('renders no source session block when the entry carries no session id', async () => {
    mockBackend({ entries: [entry({ sessionId: null })], sessionExists: true });
    render(<MemoryEntriesManager />);

    await waitFor(() => expect(screen.getByTestId('memory-entry-history')).toBeTruthy());
    expect(screen.queryByTestId('memory-entry-source-session')).toBeNull();
  });
});

describe('MemoryEntriesManager — change history and background marker (③)', () => {
  it('lists the last journal rows with operation and actor labels', async () => {
    mockBackend({
      entries: [entry()],
      journal: [
        { id: 3, timestamp: now, operation: 'update', memoryId: 'mem_1', entryId: 'mem_entry_1', actor: 'dream', beforeContent: null, afterContent: null, sessionId: null },
        { id: 2, timestamp: now, operation: 'create', memoryId: 'mem_1', entryId: 'mem_entry_1', actor: 'user_manual', beforeContent: null, afterContent: null, sessionId: 'sess-live' },
      ],
    });
    render(<MemoryEntriesManager />);

    const rows = await screen.findAllByTestId('memory-entry-history-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('更新');
    expect(rows[0].textContent).toContain('后台整理');
    expect(rows[1].textContent).toContain('创建');
    expect(rows[1].textContent).toContain('手动');
    expect(rows[1].textContent).toContain('sess-live'.slice(0, 12));
  });

  it('marks entries last changed by a background actor in the list', async () => {
    mockBackend({
      entries: [
        entry({ id: 'mem_bg', title: 'Background write', lastChange: { actor: 'eviction', operation: 'evict', timestamp: now } }),
        entry({ id: 'mem_manual', title: 'Manual write', lastChange: { actor: 'user_manual', operation: 'update', timestamp: now } }),
      ],
      journal: [],
    });
    render(<MemoryEntriesManager />);

    const badges = await screen.findAllByTestId('memory-entry-background-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('后台写入');
  });

  it('shows the empty placeholder when the journal has no rows', async () => {
    mockBackend({ entries: [entry()], journal: [] });
    render(<MemoryEntriesManager />);

    const history = await screen.findByTestId('memory-entry-history');
    await waitFor(() => expect(history.textContent).toContain('暂无变更记录'));
  });
});

// ============================================================================
// 逐行撤回（N-MEM-JOURNAL-SOURCEJUMP-FU2）：后台 actor 的 update/delete/evict
// 行给「撤回」，确认后把 before 快照整段经 memoryEntryUpdate 写回；截断快照/
// 没有快照/恢复失败 → 禁用 + 一行原因。create 行与手动行不给撤回。
// ============================================================================
function journalRow(overrides: Partial<MemoryChangeJournalRow> = {}): MemoryChangeJournalRow {
  return {
    id: 3,
    timestamp: now,
    operation: 'update',
    memoryId: 'mem_1',
    entryId: 'mem_entry_1',
    actor: 'dream',
    beforeContent: JSON.stringify({ summary: 'User prefers dark mode', status: 'active', content: 'The user prefers dark mode.' }),
    afterContent: null,
    sessionId: null,
    ...overrides,
  };
}

describe('parseMemoryJournalSnapshot — before 快照解析', () => {
  it('parses a full snapshot into title/content/status (summary → title)', () => {
    expect(parseMemoryJournalSnapshot(journalRow().beforeContent)).toEqual({
      restorable: true,
      title: 'User prefers dark mode',
      content: 'The user prefers dark mode.',
      status: 'active',
    });
  });

  it('marks truncated and unparseable snapshots as not restorable', () => {
    expect(parseMemoryJournalSnapshot('{"summary":"a","status":"acti…[truncated]')).toEqual({ restorable: false, reason: 'truncated' });
    expect(parseMemoryJournalSnapshot('not json at all')).toEqual({ restorable: false, reason: 'truncated' });
    expect(parseMemoryJournalSnapshot('{"summary":"a","status":"weird","content":"c"}')).toEqual({ restorable: false, reason: 'truncated' });
  });

  it('returns null when there is no before snapshot (create rows)', () => {
    expect(parseMemoryJournalSnapshot(null)).toBeNull();
  });
});

describe('MemoryEntriesManager — per-row undo (FU2)', () => {
  it('shows Undo only on background update/delete/evict rows, not on create or manual rows', async () => {
    mockBackend({
      entries: [entry()],
      journal: [
        journalRow({ id: 5, actor: 'dream', operation: 'update' }),
        journalRow({ id: 4, actor: 'eviction', operation: 'evict', beforeContent: JSON.stringify({ summary: 's', status: 'active', content: 'c' }) }),
        journalRow({ id: 3, actor: 'import', operation: 'create', beforeContent: null }),
        journalRow({ id: 2, actor: 'user_manual', operation: 'update', beforeContent: JSON.stringify({ summary: 's', status: 'active', content: 'c' }) }),
      ],
    });
    render(<MemoryEntriesManager />);

    const rows = await screen.findAllByTestId('memory-entry-history-row');
    expect(rows).toHaveLength(4);
    const undoButtons = screen.getAllByTestId('memory-entry-history-undo');
    expect(undoButtons).toHaveLength(2);
    expect((undoButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((undoButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the Undo with a reason when the snapshot was truncated', async () => {
    mockBackend({
      entries: [entry()],
      journal: [journalRow({
        beforeContent: '{"summary":"User prefers dark mode","status":"active","content":"The user pre…[truncated]',
      })],
    });
    render(<MemoryEntriesManager />);

    const undoButton = await screen.findByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-history-undo-reason').textContent).toContain('改写前快照被截断');
    fireEvent.click(undoButton);
    // 禁用态点不开确认弹窗
    expect(screen.queryByTestId('memory-entry-undo-preview')).toBeNull();
  });

  it('disables the Undo with a reason when an update row has no before snapshot', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow({ beforeContent: null })] });
    render(<MemoryEntriesManager />);

    const undoButton = await screen.findByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('memory-entry-history-undo-reason').textContent).toContain('没有改写前快照');
  });

  it('confirms with a preview and sends the snapshot through memoryEntryUpdate', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow()] });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('撤回这次改写？')).toBeTruthy();
    expect(within(dialog).getByTestId('memory-entry-undo-preview').textContent).toBe('The user prefers dark mode.');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    await waitFor(() => {
      const updateCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'memoryEntryUpdate');
      expect(updateCall?.[2]).toEqual({
        action: 'memoryEntryUpdate',
        entryId: 'mem_entry_1',
        title: 'User prefers dark mode',
        content: 'The user prefers dark mode.',
        status: 'active',
        deprecatedBy: null,
      });
    });
    // 成功后：重拉条目 + 重拉历史（journal 至少两次）
    await waitFor(() => {
      const journalCalls = invokeDomainMock.mock.calls.filter(([, action]) => action === 'memoryEntryJournal');
      expect(journalCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('previews only the first 200 chars of long content in the confirm dialog', async () => {
    const longContent = 'x'.repeat(300);
    mockBackend({
      entries: [entry()],
      journal: [journalRow({ beforeContent: JSON.stringify({ summary: 's', status: 'active', content: longContent }) })],
    });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('memory-entry-undo-preview').textContent).toBe(`${'x'.repeat(200)}…`);
  });

  it('does not restore to archived with deprecatedBy cleared and keeps non-active status payloads intact', async () => {
    mockBackend({
      entries: [entry()],
      journal: [journalRow({ operation: 'delete', actor: 'eviction', beforeContent: JSON.stringify({ summary: 'before title', status: 'archived', content: 'before content' }) })],
    });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    await waitFor(() => {
      const updateCall = invokeDomainMock.mock.calls.find(([, action]) => action === 'memoryEntryUpdate');
      expect(updateCall?.[2]).toEqual({
        action: 'memoryEntryUpdate',
        entryId: 'mem_entry_1',
        title: 'before title',
        content: 'before content',
        status: 'archived',
      });
    });
  });

  it('disables the row with a reason after a failed restore attempt', async () => {
    mockBackend({ entries: [entry()], journal: [journalRow()], updateResult: 'fail' });
    render(<MemoryEntriesManager />);

    fireEvent.click(await screen.findByTestId('memory-entry-history-undo'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '撤回' }));

    const reason = await screen.findByTestId('memory-entry-history-undo-reason');
    expect(reason.textContent).toContain('该条目当前无法定位');
    const undoButton = screen.getByTestId('memory-entry-history-undo');
    expect((undoButton as HTMLButtonElement).disabled).toBe(true);
  });
});
