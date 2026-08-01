// @vitest-environment jsdom
// TerminalPanel 的会话绑定契约：
//   - 会话已有活着的 PTY → 直接挂回去（面板重新挂载 ≠ 终端不存在）；
//   - 没有 → 空态 + 「打开终端」；
//   - 切会话 → 换实例，且 open 带的是新会话 id（两个会话的输出不能串）。
// xterm 在 jsdom 里跑不起来（要 canvas/measure），整体替身掉。

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDomain = vi.fn<(domain: string, action: string, payload?: unknown) => Promise<unknown>>();
const ipcOn = vi.fn<(channel: string, cb: unknown) => () => void>(() => () => {});

vi.mock('../../../src/renderer/services/ipcService', () => ({
  invokeDomain: (domain: string, action: string, payload?: unknown) => invokeDomain(domain, action, payload),
  ipcService: { on: (channel: string, cb: unknown) => ipcOn(channel, cb) },
  on: (channel: string, cb: unknown) => ipcOn(channel, cb),
  off: vi.fn(),
  invoke: vi.fn(),
}));

const termWrite = vi.fn();
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    write = termWrite;
    loadAddon = vi.fn();
    open = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { TerminalPanel } = await import('../../../src/renderer/components/workbench/TerminalPanel');
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore');

function aliveSnapshot(sessionId: string) {
  return { sessionId, data: 'previous output\r\n', cols: 80, rows: 24, alive: true };
}

beforeEach(() => {
  invokeDomain.mockReset();
  termWrite.mockReset();
  ipcOn.mockClear();
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  act(() => { useSessionStore.setState({ currentSessionId: 'chat-1' }); });
});

afterEach(cleanup);

describe('TerminalPanel session binding', () => {
  it('shows the empty state when this conversation has no terminal', async () => {
    invokeDomain.mockResolvedValue(null);

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-empty')).toBeTruthy();
    expect(screen.getByTestId('workbench-terminal-open')).toBeTruthy();
  });

  it('re-attaches without asking the user again when the pty is still alive', async () => {
    invokeDomain.mockImplementation((_domain, action) => (
      action === 'snapshot' || action === 'open'
        ? Promise.resolve(aliveSnapshot('chat-1'))
        : Promise.resolve(null)
    ));

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-live')).toBeTruthy();
    expect(screen.queryByTestId('workbench-terminal-empty')).toBeNull();
    // 历史画面补回来了，用户切走期间跑的东西不会丢。
    await waitFor(() => expect(termWrite).toHaveBeenCalledWith('previous output\r\n'));
  });

  it('does not re-attach to a pty whose shell has exited', async () => {
    invokeDomain.mockResolvedValue({ ...aliveSnapshot('chat-1'), alive: false });

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-empty')).toBeTruthy();
  });

  it('opens the terminal for the newly selected conversation after a session switch', async () => {
    invokeDomain.mockImplementation((_domain, action, payload) => (
      (action === 'snapshot' || action === 'open') && (payload as { sessionId: string }).sessionId === 'chat-2'
        ? Promise.resolve(aliveSnapshot('chat-2'))
        : Promise.resolve(null)
    ));

    render(<TerminalPanel />);
    expect(await screen.findByTestId('workbench-terminal-empty')).toBeTruthy();

    act(() => { useSessionStore.setState({ currentSessionId: 'chat-2' }); });

    expect(await screen.findByTestId('workbench-terminal-live')).toBeTruthy();
    const openCall = invokeDomain.mock.calls.find(([, action]) => action === 'open');
    expect((openCall?.[2] as { sessionId: string }).sessionId).toBe('chat-2');
  });
});
