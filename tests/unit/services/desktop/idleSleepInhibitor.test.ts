import { describe, expect, it, vi } from 'vitest';
import { IdleSleepInhibitor } from '../../../../../src/host/services/desktop/idleSleepInhibitor';

describe('IdleSleepInhibitor', () => {
  it('inhibits while a run or paired companion exists and releases when both disappear', async () => {
    let running = false; let paired = false;
    const child = { once: vi.fn((event: string, cb: (...args: unknown[]) => void) => { if (event === 'exit') void cb; return child; }), kill: vi.fn(() => true) } as any;
    const inhibitor = new IdleSleepInhibitor(() => running, () => paired, { platform: 'darwin', spawn: vi.fn(() => child) as any });
    running = true; await inhibitor.reconcile(); expect(inhibitor.getStatus().state).toBe('inhibited');
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
});
