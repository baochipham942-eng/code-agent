// @vitest-environment jsdom

import React from 'react';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ImportHistoryEntry } from '../../../src/shared/contract/importHistory';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain,
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { ExternalImportHistory } from '../../../src/renderer/components/features/settings/tabs/ExternalImportHistory';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useExternalImportHistoryStore } from '../../../src/renderer/stores/externalImportHistoryStore';

const ENTRIES: ImportHistoryEntry[] = [
  {
    id: 'chat-entry',
    at: Date.now(),
    trigger: 'manual',
    category: 'chats',
    source: 'claude_code',
    count: 1,
    items: [{ label: '重构计划', outcome: 'imported' }],
  },
  {
    id: 'skill-entry',
    at: Date.now() - 60_000,
    trigger: 'manual',
    category: 'skills',
    source: 'codex',
    count: 0,
    items: [{ label: 'alpha', outcome: 'skipped' }],
  },
];

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
  useExternalImportHistoryStore.setState({ entries: [] });
});

afterEach(cleanup);

describe('ExternalImportHistory', () => {
  it('loads and lists persisted entries with source, category, count and relative time', async () => {
    invokeDomain.mockResolvedValue(ENTRIES);
    render(<ExternalImportHistory />);

    await screen.findByTestId('external-import-history-row-chat-entry');
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.AGENT_ENGINE, 'listImportHistory');
    expect(screen.getByTestId('external-import-history-row-chat-entry').textContent)
      .toContain('刚刚 · Claude Code · 聊天 · 1 条新内容');
    expect(screen.getByTestId('external-import-history-row-skill-entry').textContent)
      .toContain('1分钟前 · Codex · 技能 · 0 条新内容');
    expect(screen.queryByTestId('external-import-history-items-chat-entry')).toBeNull();
  });

  it('expands one row to show item labels and localized outcomes, then collapses it', async () => {
    invokeDomain.mockResolvedValue(ENTRIES);
    render(<ExternalImportHistory />);

    const row = await screen.findByTestId('external-import-history-row-chat-entry');
    fireEvent.click(row.querySelector('button')!);
    expect((await screen.findByTestId('external-import-history-items-chat-entry')).textContent)
      .toBe('重构计划 · 已导入');
    fireEvent.click(row.querySelector('button')!);
    expect(screen.queryByTestId('external-import-history-items-chat-entry')).toBeNull();
  });

  it('shows the empty state and allows the whole history list to collapse', async () => {
    invokeDomain.mockResolvedValue([]);
    render(<ExternalImportHistory />);

    expect((await screen.findByTestId('external-import-history-empty')).textContent).toBe('还没有导入记录');
    fireEvent.click(screen.getByRole('button', { name: '导入历史' }));
    expect(screen.queryByTestId('external-import-history-content')).toBeNull();
  });

  it('never renders source paths or raw reason strings, and can dump the real DOM for acceptance', async () => {
    const unsafeEntries = ENTRIES.map((entry) => ({
      ...entry,
      sourcePath: '/Users/fixture/.claude/projects/private.jsonl',
      reason: 'PARSE_ERROR: /Users/fixture/raw-reason',
      items: entry.items.map((item) => ({ ...item, reason: 'copy-failed: /Users/fixture/raw-item-reason' })),
    }));
    invokeDomain.mockResolvedValue(unsafeEntries);
    render(<ExternalImportHistory />);

    const row = await screen.findByTestId('external-import-history-row-chat-entry');
    fireEvent.click(row.querySelector('button')!);
    await screen.findByTestId('external-import-history-items-chat-entry');
    const dom = document.body.textContent ?? '';
    expect(dom).not.toContain('/Users/fixture');
    expect(dom).not.toContain('PARSE_ERROR');
    expect(dom).not.toContain('copy-failed');
    expect(dom).not.toContain('raw-reason');
    if (process.env.IMPORT_HISTORY_DOM_DUMP) {
      await fs.writeFile(process.env.IMPORT_HISTORY_DOM_DUMP, document.body.innerHTML, 'utf8');
    }
  });
});
