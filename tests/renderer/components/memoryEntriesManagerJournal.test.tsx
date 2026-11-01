// ============================================================================
// MemoryEntriesManager — 来源会话跳转 + 变更历史 + 后台写入标记
// （N-MEM-JOURNAL-SOURCEJUMP ② ③）
// ============================================================================
// ② 有来源会话 → 可点跳转（带 messageId 落点消息）；会话没了 → 禁用 + 原因
// ③ 详情展示最近变更日志行；最近一次是后台 actor 的条目在列表里带标记
// ============================================================================

// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry, MemoryEntryListResult, MemoryChangeJournalResult } from '../../../src/shared/contract/memory';

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

/** route invokeDomain：MEMORY 三个动作 + SESSION 存在性探测（只读 sessionExists，load 一律 unexpected） */
function mockBackend(options: {
  entries: MemoryEntry[];
  journal?: MemoryChangeJournalResult['rows'];
  sessionExists?: boolean | 'throw';
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
