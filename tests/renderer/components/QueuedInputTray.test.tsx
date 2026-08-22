// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedInput, QueuedInputSettledEvent } from '../../../src/shared/contract/queuedInput';

const ipc = vi.hoisted(() => ({
  invokeDomain: vi.fn(),
  on: vi.fn(),
  settledHandler: null as ((event: QueuedInputSettledEvent) => void) | null,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: ipc.invokeDomain,
    on: ipc.on,
  },
}));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    t: {
      waitingInputTray: {
        title: '排队中 · {count}',
        collapse: '收起',
        expand: '展开',
        edit: '编辑',
        retract: '撤回',
        sendNow: '现在就说',
        failed: '没发出去',
        retry: '重试',
        delete: '删除',
        editing: '编辑中',
        drag: '拖拽排序',
      },
    },
  }),
}));

import { QueuedInputTray } from '../../../src/renderer/components/features/chat/ChatInput/QueuedInputTray';

function input(id: string, overrides: Partial<QueuedInput> = {}): QueuedInput {
  return {
    id,
    sessionId: 'session-1',
    envelope: { content: `content-${id}` },
    status: 'queued',
    retryCount: 0,
    position: 0,
    pausedReason: null,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('QueuedInputTray', () => {
  let items: QueuedInput[];

  beforeEach(() => {
    items = [];
    ipc.invokeDomain.mockReset().mockImplementation(async (_domain, action, payload) => {
      if (action === 'list') return items;
      if (action === 'retract') {
        items = items.filter((item) => item.id !== payload.id);
        return { retracted: true };
      }
      if (action === 'sendNow') {
        items = items.filter((item) => item.id !== payload.id);
        return { status: 'consumed', retryCount: 0 };
      }
      if (action === 'reorder') return { reordered: true };
      throw new Error(`Unexpected action: ${action}`);
    });
    ipc.settledHandler = null;
    ipc.on.mockReset().mockImplementation((_channel, handler) => {
      ipc.settledHandler = handler;
      return vi.fn();
    });
  });

  afterEach(() => cleanup());

  it('没有条目时不渲染，有条目后才显示标题', async () => {
    const view = render(
      <QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={vi.fn()} />,
    );
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalled());
    expect(screen.queryByTestId('queued-input-tray')).toBeNull();

    items = [input('one')];
    view.rerender(
      <QueuedInputTray sessionId="session-1" revision={1} editingId={null} onEdit={vi.fn()} />,
    );
    expect(await screen.findByText('排队中 · 1')).toBeTruthy();
  });

  it('悬停才显示行级动作，编辑回调、撤回和现在就说都走对应入口', async () => {
    items = [input('one'), input('two', { position: 1 })];
    const onEdit = vi.fn();
    render(<QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={onEdit} />);
    const firstRow = await screen.findByTestId('queued-input-row-one');
    expect(screen.queryByTestId('queued-input-actions-one')).toBeNull();

    fireEvent.mouseEnter(firstRow);
    expect(screen.getByTestId('queued-input-actions-one')).toBeTruthy();
    fireEvent.click(screen.getByText('编辑'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));

    fireEvent.click(screen.getByText('撤回'));
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'retract', { id: 'one' },
    ));

    const secondRow = await screen.findByTestId('queued-input-row-two');
    fireEvent.mouseEnter(secondRow);
    fireEvent.click(screen.getByText('现在就说'));
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'sendNow', { id: 'two' },
    ));
  });

  it('paused 行显示黄标，并把动作收敛为重试和删除', async () => {
    items = [input('paused', { pausedReason: 'restart' })];
    render(<QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={vi.fn()} />);
    const row = await screen.findByTestId('queued-input-row-paused');
    expect(screen.getByText('没发出去')).toBeTruthy();
    fireEvent.mouseEnter(row);
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
  });

  it('收到 settled 事件后重新拉取列表', async () => {
    items = [input('one')];
    render(<QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={vi.fn()} />);
    expect(await screen.findByText('content-one')).toBeTruthy();
    items = [];

    await act(async () => {
      ipc.settledHandler?.({ sessionId: 'session-1', id: 'one', status: 'consumed' });
    });
    await waitFor(() => expect(screen.queryByTestId('queued-input-tray')).toBeNull());
    expect(ipc.invokeDomain.mock.calls.filter((call) => call[1] === 'list')).toHaveLength(2);
  });
});
