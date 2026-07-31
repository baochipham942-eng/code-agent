import { beforeEach, describe, expect, it } from 'vitest';
import { useManagedBrowserOwnerStore } from '../../../src/renderer/stores/managedBrowserOwnerStore';

function note(input: { running: boolean; browserSessionId?: string | null; currentSessionId: string | null }) {
  return useManagedBrowserOwnerStore.getState().noteManagedBrowserSession({
    running: input.running,
    browserSessionId: input.browserSessionId ?? null,
    currentSessionId: input.currentSessionId,
  });
}

describe('managed browser ownership (B1 · S4 退化路径)', () => {
  beforeEach(() => {
    useManagedBrowserOwnerStore.getState().resetManagedBrowserOwnerForTests();
  });

  it('非 running → running 记一次启动，归属记成当时的前台会话', () => {
    expect(note({ running: false, currentSessionId: 'session-a' })).toBe(false);
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' })).toBe(true);
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
  });

  it('同一 running 会话重复观察只算一次——多个 hook 消费者不会各抢一次焦点', () => {
    note({ running: false, currentSessionId: 'session-a' });
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' })).toBe(true);
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' })).toBe(false);
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' })).toBe(false);
  });

  it('切到别的会话不改归属——A 启动的窗在 B 里仍归 A', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-b' })).toBe(false);
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
  });

  it('停掉后重新启动会重新武装，并把归属交给新的前台会话', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    expect(note({ running: false, currentSessionId: 'session-b' })).toBe(false);
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBeNull();
    expect(note({ running: true, browserSessionId: 'browser-2', currentSessionId: 'session-b' })).toBe(true);
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-b');
  });

  it('首次观察就已经在跑（上次 app 生命周期留下的）不算本轮启动，不抢焦点', () => {
    expect(note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' })).toBe(false);
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
  });

  it('host 没给 sessionId 时仍靠 running/stopped 切换重新武装', () => {
    note({ running: false, currentSessionId: 'session-a' });
    expect(note({ running: true, browserSessionId: null, currentSessionId: 'session-a' })).toBe(true);
    expect(note({ running: true, browserSessionId: null, currentSessionId: 'session-a' })).toBe(false);
    note({ running: false, currentSessionId: 'session-a' });
    expect(note({ running: true, browserSessionId: null, currentSessionId: 'session-a' })).toBe(true);
  });
});
