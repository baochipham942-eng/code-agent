// @vitest-environment jsdom
// 导入历史「撤销这次导入」（N-EXTHISTORY-IMPORT-SYNC-UNDO）：按钮 → 内联确认（带数量）→ 成功态 + 保留清单；
// 无引用的旧条目不出按钮；zh / en 文案齐备。

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ImportHistoryEntry } from '../../../src/shared/contract/importHistory';
import { IPC_DOMAINS } from '../../../src/shared/ipc/domains';

const invokeDomain = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
    invokeDomain: (...args: unknown[]) => invokeDomain(...args),
    on: () => () => {},
    off: vi.fn(),
  },
}));

import { ExternalImportHistory } from '../../../src/renderer/components/features/settings/tabs/ExternalImportHistory';
import { useAppStore } from '../../../src/renderer/stores/appStore';
import { useExternalImportHistoryStore } from '../../../src/renderer/stores/externalImportHistoryStore';

const UNDOABLE: ImportHistoryEntry = {
  id: 'undoable',
  at: Date.now(),
  trigger: 'manual',
  category: 'chats',
  source: 'claude_code',
  count: 2,
  items: [
    { label: '重构计划', outcome: 'imported', sourceSessionId: 's-1' },
    { label: '旧问答', outcome: 'imported', sourceSessionId: 's-2' },
  ],
};
const LEGACY: ImportHistoryEntry = {
  id: 'legacy',
  at: Date.now() - 60_000,
  trigger: 'manual',
  category: 'chats',
  source: 'claude_code',
  count: 1,
  items: [{ label: '老记录', outcome: 'imported' }],
};

beforeEach(() => {
  invokeDomain.mockReset();
  useAppStore.setState({ language: 'zh' });
  useExternalImportHistoryStore.setState({ entries: [] });
});
afterEach(cleanup);

describe('ExternalImportHistory undo', () => {
  it('③ hides the undo button for a legacy entry without refs', async () => {
    invokeDomain.mockResolvedValue([LEGACY]);
    render(<ExternalImportHistory />);
    await screen.findByTestId('external-import-history-row-legacy');
    expect(screen.queryByText('撤销这次导入')).toBeNull();
  });

  it('⑤ button -> confirm with counts -> Undone state with kept list', async () => {
    invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'listImportHistory') return [UNDOABLE];
      return {
        ...UNDOABLE,
        undone: { at: 1, removed: 1, kept: [{ label: '旧问答', reason: 'continued' }] },
      };
    });
    render(<ExternalImportHistory />);
    fireEvent.click(await screen.findByText('撤销这次导入'));

    const confirm = screen.getByTestId('external-import-history-undo-confirm-undoable').textContent ?? '';
    expect(confirm).toContain('2 个聊天');
    expect(confirm).toContain('0 个技能');
    expect(confirm).toContain('不会再被自动导入');

    fireEvent.click(screen.getByText('确认撤销'));
    const undone = await screen.findByTestId('external-import-history-undone-undoable');
    expect(invokeDomain).toHaveBeenCalledWith(IPC_DOMAINS.AGENT_ENGINE, 'undoImportHistory', { entryId: 'undoable' });
    expect(undone.textContent).toContain('已撤销');
    expect(undone.textContent).toContain('保留 1 项');
    expect(undone.textContent).toContain('旧问答 · 已有后续对话');
    expect(screen.queryByText('撤销这次导入')).toBeNull();
  });

  it('shows a fixed failure line and keeps the confirm open when undo fails', async () => {
    invokeDomain.mockImplementation(async (_domain: string, action: string) => {
      if (action === 'listImportHistory') return [UNDOABLE];
      throw new Error('INTERNAL: /Users/x');
    });
    render(<ExternalImportHistory />);
    fireEvent.click(await screen.findByText('撤销这次导入'));
    fireEvent.click(screen.getByText('确认撤销'));
    await screen.findByText('撤销失败，请稍后再试');
    expect(document.body.textContent).not.toContain('/Users/x');
  });

  it('⑤ en copy is present', async () => {
    useAppStore.setState({ language: 'en' });
    invokeDomain.mockResolvedValue([UNDOABLE]);
    render(<ExternalImportHistory />);
    fireEvent.click(await screen.findByText('Undo this import'));
    expect(screen.getByTestId('external-import-history-undo-confirm-undoable').textContent)
      .toBe('Remove 2 chats and 0 skills. Chats you already continued and skills you edited are kept. Undone chats will not be auto-imported again.');
  });
});
