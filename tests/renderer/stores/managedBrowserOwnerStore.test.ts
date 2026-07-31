import { beforeEach, describe, expect, it } from 'vitest';
import { useManagedBrowserOwnerStore } from '../../../src/renderer/stores/managedBrowserOwnerStore';

function note(input: { running: boolean; browserSessionId?: string | null; currentSessionId: string | null }) {
  useManagedBrowserOwnerStore.getState().noteManagedBrowserSession({
    running: input.running,
    browserSessionId: input.browserSessionId ?? null,
    currentSessionId: input.currentSessionId,
  });
}

function noteSurface(surfaceSessionId: string | null): boolean {
  return useManagedBrowserOwnerStore.getState().noteBrowserSurfaceSession(surfaceSessionId);
}

describe('managed browser ownership (B1 · S4 退化路径，只记归属不再驱动 auto-open)', () => {
  beforeEach(() => {
    useManagedBrowserOwnerStore.getState().resetManagedBrowserOwnerForTests();
  });

  it('非 running → running 把归属记成当时的前台会话', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
  });

  it('切到别的会话不改归属——A 启动的窗在 B 里仍归 A', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-b' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
  });

  it('停掉后重新启动会把归属交给新的前台会话', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    note({ running: false, currentSessionId: 'session-b' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBeNull();
    note({ running: true, browserSessionId: 'browser-2', currentSessionId: 'session-b' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-b');
  });

  it('首次观察就已经在跑（上次 app 生命周期留下的）也记下归属，但不抢焦点（无返回值可用）', () => {
    note({ running: true, browserSessionId: 'browser-1', currentSessionId: 'session-a' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
    // 用户手动 launch 不再触发 auto-open：这条路径压根没有 auto-open 信号可发。
    expect(useManagedBrowserOwnerStore.getState().browserSurfaceSessionId).toBeNull();
  });

  it('host 没给 sessionId 时仍靠 running/stopped 切换重新记账', () => {
    note({ running: false, currentSessionId: 'session-a' });
    note({ running: true, browserSessionId: null, currentSessionId: 'session-a' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBe('session-a');
    note({ running: false, currentSessionId: 'session-b' });
    expect(useManagedBrowserOwnerStore.getState().ownerSessionId).toBeNull();
  });
});

describe('browser surface 会话边沿（B1-R · R2 auto-open 信号源）', () => {
  beforeEach(() => {
    useManagedBrowserOwnerStore.getState().resetManagedBrowserOwnerForTests();
  });

  it('出现新的 browser surface 会话时返回 true，该抢焦点', () => {
    expect(noteSurface('surface-1')).toBe(true);
  });

  it('同一会话重复观察只算一次——5 个 hook 消费者不会各抢一次焦点', () => {
    expect(noteSurface('surface-1')).toBe(true);
    expect(noteSurface('surface-1')).toBe(false);
    expect(noteSurface('surface-1')).toBe(false);
  });

  it('会话结束（变 null）不算启动，不抢焦点', () => {
    noteSurface('surface-1');
    expect(noteSurface(null)).toBe(false);
  });

  it('结束后又起一个新会话会重新武装', () => {
    noteSurface('surface-1');
    noteSurface(null);
    expect(noteSurface('surface-2')).toBe(true);
  });

  it('直接换成另一个 surface 会话也算新启动', () => {
    noteSurface('surface-1');
    expect(noteSurface('surface-2')).toBe(true);
  });
});
