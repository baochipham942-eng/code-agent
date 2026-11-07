import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { BROWSER_TIMEOUTS } from '../../../../src/shared/constants/timeouts';
import {
  BrowserPool,
  BrowserPoolBusyError,
  bindBrowserPoolReleaseHook,
  browserPool,
} from '../../../../src/host/services/infra/browserPool';

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = new BrowserPool(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the same instance for the default agent (no agentId)', () => {
    const a = pool.acquire();
    const b = pool.acquire(undefined);
    const c = pool.acquire(null);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('returns distinct instances for different named agents', () => {
    const def = pool.acquire();
    const a = pool.acquire('agent-a');
    const b = pool.acquire('agent-b');
    expect(a).not.toBe(def);
    expect(b).not.toBe(def);
    expect(a).not.toBe(b);
  });

  it('caches per-agent instance across repeated acquire calls', () => {
    const first = pool.acquire('agent-a');
    const second = pool.acquire('agent-a');
    expect(first).toBe(second);
  });

  it('isolates persistent profileId by agentId so Chromium user-data-dir does not collide', () => {
    const defProfile = pool.acquire().getSessionState().profileId;
    const aProfile = pool.acquire('agent-a').getSessionState().profileId;
    const bProfile = pool.acquire('agent-b').getSessionState().profileId;
    expect(aProfile).not.toBe(defProfile);
    expect(aProfile).not.toBe(bProfile);
    expect(aProfile).toContain('agent-a');
    expect(bProfile).toContain('agent-b');
  });

  it('reclaims the least recently used idle named agent once it has been idle long enough', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const timed = new BrowserPool(2);
    const older = timed.acquire('agent-old');
    const olderClose = vi.spyOn(older, 'close');
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    timed.acquire('agent-newer');
    vi.setSystemTime(new Date(Date.now() + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM));

    timed.acquire('agent-new');

    expect(timed.hasAgent('agent-old')).toBe(false);
    expect(olderClose).toHaveBeenCalledTimes(1);
    expect(timed.hasAgent('agent-newer')).toBe(true);
    expect(timed.hasAgent('agent-new')).toBe(true);
    vi.useRealTimers();
  });

  it('does not reclaim an idle entry before the idle threshold, then reclaims it at the threshold', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const timed = new BrowserPool(1);
    const first = timed.acquire('agent-a');
    const close = vi.spyOn(first, 'close');
    vi.setSystemTime(new Date(Date.now() + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM - 1));

    expect(() => timed.acquire('agent-b')).toThrow(BrowserPoolBusyError);
    expect(close).not.toHaveBeenCalled();
    expect(timed.hasAgent('agent-a')).toBe(true);
    expect(timed.hasAgent('agent-b')).toBe(false);

    vi.setSystemTime(new Date(Date.now() + 1));
    timed.acquire('agent-c');
    expect(timed.hasAgent('agent-a')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(timed.hasAgent('agent-c')).toBe(true);
    vi.useRealTimers();
  });

  it('never evicts an in-use entry even when lastUsedAt is older than the idle threshold', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const timed = new BrowserPool(1);
    const held = timed.acquire('agent-a');
    timed.setInUse('agent-a', true);
    const close = vi.spyOn(held, 'close');
    vi.setSystemTime(new Date(Date.now() + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM + 60_000));

    expect(() => timed.acquire('agent-b')).toThrow(BrowserPoolBusyError);
    expect(close).not.toHaveBeenCalled();
    expect(timed.hasAgent('agent-a')).toBe(true);
    vi.useRealTimers();
  });

  it('reclaims one idle-over-threshold entry when four others are in use', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const timed = new BrowserPool(5);
    const inUseCloses = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map((id) => {
      const service = timed.acquire(id);
      timed.setInUse(id, true);
      return vi.spyOn(service, 'close');
    });
    const idle = timed.acquire('agent-idle');
    const idleClose = vi.spyOn(idle, 'close');
    vi.setSystemTime(new Date(Date.now() + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM));

    timed.acquire('agent-new');

    expect(timed.hasAgent('agent-idle')).toBe(false);
    expect(idleClose).toHaveBeenCalledTimes(1);
    expect(timed.hasAgent('agent-new')).toBe(true);
    for (const close of inUseCloses) expect(close).not.toHaveBeenCalled();
    expect(timed.listAgents().sort()).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-new']);
    vi.useRealTimers();
  });

  it('throws BrowserPoolBusyError when four named entries are in use and closes none of them', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const timed = new BrowserPool(4);
    const personal = timed.acquire();
    const personalClose = vi.spyOn(personal, 'close');
    const closes = ['agent-a', 'agent-b', 'agent-c', 'agent-d'].map((id) => {
      const service = timed.acquire(id);
      timed.setInUse(id, true);
      return vi.spyOn(service, 'close');
    });
    vi.setSystemTime(new Date(Date.now() + BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM * 2));

    let caught: unknown;
    try {
      timed.acquire('agent-e');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserPoolBusyError);
    expect((caught as BrowserPoolBusyError).message).toBe(
      '4 other conversations are using the browser. Wait for one to finish or end one conversation. Do not retry this tool in a loop.',
    );
    expect(timed.hasAgent('agent-e')).toBe(false);
    expect(personalClose).not.toHaveBeenCalled();
    for (const close of closes) expect(close).not.toHaveBeenCalled();
    expect(timed.listAgents().sort()).toEqual(['agent-a', 'agent-b', 'agent-c', 'agent-d']);
    vi.useRealTimers();
  });

  it('does not count the default agent toward the LRU capacity', () => {
    pool.acquire();
    pool.acquire('agent-a');
    pool.acquire('agent-b');
    pool.acquire('agent-c');

    expect(pool.listAgents()).toHaveLength(3);
    expect(pool.hasAgent('agent-a')).toBe(true);
  });

  it('releases a named agent on demand without touching the default agent', async () => {
    const def = pool.acquire();
    pool.acquire('agent-a');
    expect(pool.hasAgent('agent-a')).toBe(true);

    await pool.releaseAgent('agent-a');
    expect(pool.hasAgent('agent-a')).toBe(false);
    expect(pool.acquire()).toBe(def);
  });

  it('ignores releaseAgent for default key', async () => {
    const def = pool.acquire();
    await pool.releaseAgent('__default__');
    expect(pool.acquire()).toBe(def);
  });

  it('ignores setInUse for the personal default key and for a missing entry', () => {
    const def = pool.acquire();
    pool.setInUse('__default__', true);
    pool.setInUse('missing-agent', true);
    expect(pool.acquire()).toBe(def);
    expect(pool.hasAgent('missing-agent')).toBe(false);
  });
});

describe('bindBrowserPoolReleaseHook', () => {
  afterEach(async () => {
    for (const id of browserPool.listAgents()) {
      await browserPool.releaseAgent(id);
    }
  });

  it('releases only the completed agent id and never the personal default key', async () => {
    const callbacks: Array<(agent: { id: string }) => void> = [];
    const guard = {
      onComplete(callback: (agent: { id: string }) => void) {
        callbacks.push(callback);
      },
    };
    bindBrowserPoolReleaseHook(guard);
    bindBrowserPoolReleaseHook(guard);
    expect(callbacks).toHaveLength(1);

    const legacyId = 'legacy-agent-id';
    const otherId = 'other-agent-id';
    browserPool.acquire(legacyId);
    browserPool.acquire(otherId);
    const personal = browserPool.acquire();

    callbacks[0]({ id: legacyId });
    expect(browserPool.hasAgent(legacyId)).toBe(false);
    expect(browserPool.hasAgent(otherId)).toBe(true);

    callbacks[0]({ id: '__default__' });
    expect(browserPool.acquire()).toBe(personal);
    expect(browserPool.hasAgent(otherId)).toBe(true);
  });

  it('releases a legacy agentId key when that spawned agent completes', async () => {
    const { executeSpawnAgent } = await import('../../../../src/host/agent/multiagentTools/spawnAgent');
    const { getSpawnGuard, resetSpawnGuard } = await import('../../../../src/host/agent/spawnGuard');
    resetSpawnGuard();
    await executeSpawnAgent({}, {
      runId: 'run-pool-release',
      sessionId: 'session-pool-release',
      workspace: '/tmp',
      cwd: '/tmp',
      modelConfig: { provider: 'test', model: 'test-model' },
      resolver: undefined,
      permission: { request: async () => true },
      events: { emit: () => undefined },
      abortSignal: new AbortController().signal,
      currentToolCallId: 'tool-pool-release',
    } as never);

    const legacyId = 'legacy-pool-agent';
    const otherId = 'other-pool-agent';
    browserPool.acquire(legacyId);
    browserPool.acquire(otherId);
    const personal = browserPool.acquire();
    const guard = getSpawnGuard();
    const done = Promise.resolve({ success: true, output: 'done' });
    guard.register(
      legacyId,
      'dynamic',
      'task',
      done as never,
      new AbortController(),
      { slotAcquired: true },
    );
    await done;
    expect(browserPool.hasAgent(legacyId)).toBe(false);
    expect(browserPool.hasAgent(otherId)).toBe(true);

    const untouched = Promise.resolve({ success: true, output: 'skip' });
    guard.register(
      '__default__',
      'dynamic',
      'personal',
      untouched as never,
      new AbortController(),
      { slotAcquired: true },
    );
    await untouched;
    expect(browserPool.acquire()).toBe(personal);
    resetSpawnGuard();
  });
});
