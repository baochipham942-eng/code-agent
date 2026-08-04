// @vitest-environment jsdom
// TerminalPanel 的会话绑定契约（2026-08-04 产品负责人拍板：打开 tab 即自动起终端，不需要多点一下）：
//   - 有会话 → 挂载即 open（有活着的 PTY 就接管、没有就新建），不再出现手点空态；
//   - 无会话 → 空态（唯一还会出现空态的场景）；
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
  it('auto-opens a terminal when this conversation has none yet (no extra click)', async () => {
    invokeDomain.mockImplementation((_domain, action) => (
      action === 'open' ? Promise.resolve(aliveSnapshot('chat-1')) : Promise.resolve(null)
    ));

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-live')).toBeTruthy();
    expect(screen.queryByTestId('workbench-terminal-empty')).toBeNull();
    const openCall = invokeDomain.mock.calls.find(([, action]) => action === 'open');
    expect((openCall?.[2] as { sessionId: string }).sessionId).toBe('chat-1');
  });

  it('shows the empty state only when there is no conversation at all', async () => {
    invokeDomain.mockResolvedValue(null);
    act(() => { useSessionStore.setState({ currentSessionId: null }); });

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-empty')).toBeTruthy();
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

  it('starts a fresh terminal instead of a dead-end when the previous shell has exited', async () => {
    // 旧契约是「死 PTY → 空态等手点」；拍板后 open 语义=有则接管无则新建，死 PTY 直接换新。
    invokeDomain.mockImplementation((_domain, action) => (
      action === 'open' ? Promise.resolve(aliveSnapshot('chat-1')) : Promise.resolve(null)
    ));

    render(<TerminalPanel />);

    expect(await screen.findByTestId('workbench-terminal-live')).toBeTruthy();
  });

  it('replays live chunks after the snapshot instead of duplicating them', async () => {
    // 订阅必须早于 open（不然漏帧），但快照是「open 那一刻」的前缀——这中间到的实时块
    // 直接写下去会先出现一次、再随快照重复一次。这条钉住「先攒后放」。
    let releaseOpen: (value: unknown) => void = () => {};
    invokeDomain.mockImplementation((_domain, action) => {
      if (action === 'snapshot') return Promise.resolve(aliveSnapshot('chat-1'));
      if (action === 'open') return new Promise((resolve) => { releaseOpen = resolve; });
      return Promise.resolve(null);
    });

    render(<TerminalPanel />);
    await screen.findByTestId('workbench-terminal-live');

    // open 还没返回，实时输出先到了
    const listener = ipcOn.mock.calls.at(-1)?.[1] as (e: { sessionId: string; data: string }) => void;
    act(() => { listener({ sessionId: 'chat-1', data: 'LIVE' }); });
    expect(termWrite).not.toHaveBeenCalledWith('LIVE');

    await act(async () => { releaseOpen(aliveSnapshot('chat-1')); });

    const order = termWrite.mock.calls.map(([chunk]) => chunk as string);
    expect(order).toEqual(['previous output\r\n', 'LIVE']);
    expect(order.filter((chunk) => chunk === 'LIVE')).toHaveLength(1);
  });

  it('opens the terminal for the newly selected conversation after a session switch', async () => {
    invokeDomain.mockImplementation((_domain, action, payload) => (
      (action === 'snapshot' || action === 'open') && (payload as { sessionId: string }).sessionId === 'chat-2'
        ? Promise.resolve(aliveSnapshot('chat-2'))
        : Promise.resolve(null)
    ));

    render(<TerminalPanel />);
    await screen.findByTestId('workbench-terminal-live');

    act(() => { useSessionStore.setState({ currentSessionId: 'chat-2' }); });

    await waitFor(() => {
      const openCalls = invokeDomain.mock.calls.filter(([, action]) => action === 'open');
      expect((openCalls.at(-1)?.[2] as { sessionId: string }).sessionId).toBe('chat-2');
    });
  });
});
