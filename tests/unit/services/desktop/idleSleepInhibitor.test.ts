import { describe, expect, it, vi } from 'vitest';
import { IdleSleepInhibitor } from '../../../../src/host/services/desktop/idleSleepInhibitor';

describe('IdleSleepInhibitor', () => {
  it('inhibits while a run or paired companion exists and releases when both disappear', async () => {
    let running = false; let paired = false;
    const child = { once: vi.fn((event: string, cb: (...args: unknown[]) => void) => { if (event === 'exit') void cb; return child; }), kill: vi.fn(() => true) } as any;
    const spawnMock = vi.fn(() => child) as any;
    const inhibitor = new IdleSleepInhibitor(() => running, () => paired, { platform: 'darwin', spawn: spawnMock });
    running = true; await inhibitor.reconcile(); expect(inhibitor.getStatus().state).toBe('inhibited');
    // -i 阻止空闲休眠，-w 盯住宿主 pid（宿主崩溃/强退时 caffeinate 随之退出，不成孤儿）。
    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    running = false; paired = true; await inhibitor.reconcile(); expect(inhibitor.getStatus().state).toBe('inhibited');
    paired = false; await inhibitor.reconcile(); expect(child.kill).toHaveBeenCalledWith('SIGTERM'); expect(inhibitor.getStatus().state).toBe('released');
  });

  it('reports unsupported platforms truthfully', async () => {
    const inhibitor = new IdleSleepInhibitor(() => true, () => false, { platform: 'linux' });
    await inhibitor.reconcile(); expect(inhibitor.getStatus()).toEqual({ state: 'unavailable', reason: 'unsupported-platform' });
  });

  it('reports start failures truthfully', async () => {
    const inhibitor = new IdleSleepInhibitor(() => true, () => false, { platform: 'darwin', spawn: vi.fn(() => { throw new Error('missing'); }) as any });
    await inhibitor.reconcile(); expect(inhibitor.getStatus()).toEqual({ state: 'unavailable', reason: 'start-failed' });
  });

  it('ignores a stale child exit event after respawn', async () => {
    const running = true;
    const exits: ((...args: unknown[]) => void)[] = [];
    const mkChild = () => ({ once: vi.fn((event: string, cb: (...args: unknown[]) => void) => { if (event === 'exit') exits.push(cb); }), kill: vi.fn(() => true) } as any);
    const inhibitor = new IdleSleepInhibitor(() => running, () => false, { platform: 'darwin', spawn: vi.fn(mkChild) as any });
    await inhibitor.reconcile();
    await inhibitor.stop();          // release：kill 旧 child，其 exit 事件随后才投递
    await inhibitor.reconcile();     // 触发源仍在 → 重新 spawn 新 child
    exits[0](0, null);               // 旧 child 的迟到 exit 不能抹掉新句柄/误标 start-failed
    expect(inhibitor.getStatus().state).toBe('inhibited');
  });

  it('backs off instead of retrying every tick after repeated start failures', async () => {
    const spawnMock = vi.fn(() => { throw new Error('missing'); }) as any;
    const inhibitor = new IdleSleepInhibitor(() => true, () => false, { platform: 'darwin', spawn: spawnMock });
    await inhibitor.reconcile();
    await inhibitor.reconcile();
    await inhibitor.reconcile();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
