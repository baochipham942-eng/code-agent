import { describe, expect, it, beforeEach } from 'vitest';
import { BrowserPool } from '../../../../src/host/services/infra/browserPool';

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    pool = new BrowserPool(3);
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

  it('evicts the least recently used named agent when max named capacity is reached', async () => {
    pool.acquire('agent-a');
    pool.acquire('agent-b');
    pool.acquire('agent-c');
    expect(pool.listAgents().sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);

    pool.acquire('agent-b');
    pool.acquire('agent-d');

    expect(pool.hasAgent('agent-a')).toBe(false);
    expect(pool.listAgents().sort()).toEqual(['agent-b', 'agent-c', 'agent-d']);
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
});
