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
        redirectNow: '立即改道',
        failed: '没发出去',
        retry: '重试',
        delete: '删除',
        editing: '编辑中',
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

  it('不暴露拖拽排序，动作默认淡出且 hover/focus 时可见并保持可聚焦', async () => {
    items = [input('one'), input('two', { position: 1 })];
    const { container } = render(
      <QueuedInputTray sessionId="session-1" revision={0} editingId="one" onEdit={vi.fn()} />,
    );
    const firstRow = await screen.findByTestId('queued-input-row-one');
    const actions = screen.getByTestId('queued-input-actions-one');

    expect(container.querySelector('[draggable]')).toBeNull();
    expect(firstRow.hasAttribute('draggable')).toBe(false);
    expect(actions.className).toContain('opacity-0');
    expect(actions.className).toContain('group-hover:opacity-100');
    expect(actions.className).toContain('group-focus-within:opacity-100');
    expect(actions.textContent).toBe('编辑撤回');
    expect(screen.getByText('编辑中').className).not.toContain('bg-');
    fireEvent.mouseEnter(firstRow);
    expect(actions.className).toContain('group-hover:opacity-100');
    const redirect = screen.getAllByRole('button', { name: '立即改道' })[0];
    expect(redirect.getAttribute('title')).toBe('立即改道');
    redirect.focus();
    expect(document.activeElement).toBe(redirect);
  });

  it('普通行的编辑和撤回都走对应入口', async () => {
    items = [input('one'), input('two', { position: 1 }), input('three', { position: 2 })];
    const onEdit = vi.fn();
    render(<QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={onEdit} />);
    await screen.findByTestId('queued-input-row-one');

    fireEvent.click(screen.getAllByText('编辑')[0]);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));

    fireEvent.click(screen.getAllByText('撤回')[0]);
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'retract', { id: 'one' },
    ));
    await waitFor(() => expect(screen.queryByTestId('queued-input-row-one')).toBeNull());

  });

  it('改道指定条目时只取出该条，其余排队条保持不变', async () => {
    items = [input('one'), input('two', { position: 1 }), input('three', { position: 2 })];
    render(<QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={vi.fn()} />);
    await screen.findByTestId('queued-input-row-one');

    fireEvent.click(screen.getByTestId('queued-input-redirect-two'));
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'sendNow', { id: 'two' },
    ));
    await waitFor(() => expect(screen.queryByTestId('queued-input-row-two')).toBeNull());
    expect(screen.getByTestId('queued-input-row-one')).toBeTruthy();
    expect(screen.getByTestId('queued-input-row-three')).toBeTruthy();
    expect(items.map((item) => item.id)).toEqual(['one', 'three']);
  });

  it('paused 行只显示警告图标且无黄底 pill，动作收敛为重试和删除', async () => {
    items = [input('paused', { pausedReason: 'restart' })];
    const view = render(
      <QueuedInputTray sessionId="session-1" revision={0} editingId={null} onEdit={vi.fn()} />,
    );
    const row = await screen.findByTestId('queued-input-row-paused');
    expect(screen.getByTitle('没发出去').textContent).toBe('⚠');
    expect(row.querySelector('[class*="bg-amber"]')).toBeNull();
    expect(screen.queryByText('编辑')).toBeNull();

    fireEvent.click(screen.getByText('重试'));
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'sendNow', { id: 'paused' },
    ));
    await waitFor(() => expect(screen.queryByTestId('queued-input-tray')).toBeNull());

    items = [input('failed', { status: 'failed' })];
    view.rerender(
      <QueuedInputTray sessionId="session-1" revision={1} editingId={null} onEdit={vi.fn()} />,
    );
    await screen.findByTestId('queued-input-row-failed');
    fireEvent.click(screen.getByText('删除'));
    await waitFor(() => expect(ipc.invokeDomain).toHaveBeenCalledWith(
      expect.anything(), 'retract', { id: 'failed' },
    ));
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
