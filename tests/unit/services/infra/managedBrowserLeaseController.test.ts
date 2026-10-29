import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedBrowserLeaseController } from '../../../../src/host/services/infra/browser/managedBrowserLeaseController';
import { BROWSER_TIMEOUTS } from '../../../../src/shared/constants/timeouts';

const TTL = 5000; // clamp floor is 5s

describe('ManagedBrowserLeaseController in-use pin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('baseline: not in use -> expires and calls onExpired', () => {
    const onExpired = vi.fn();
    const c = new ManagedBrowserLeaseController(onExpired);
    c.renew({ ttlMs: TTL });
    vi.advanceTimersByTime(TTL + 1);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(c.getState()?.status).toBe('expired');
  });

  it('in use: timer fire extends the lease instead of expiring', () => {
    const onExpired = vi.fn();
    const c = new ManagedBrowserLeaseController(onExpired);
    c.renew({ ttlMs: TTL });
    c.setInUse(true);
    vi.advanceTimersByTime(TTL * 3);
    expect(onExpired).not.toHaveBeenCalled();
    const state = c.getState();
    expect(state?.status).toBe('active');
    expect(state!.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('clearing the flag lets the next expiry fire onExpired', () => {
    const onExpired = vi.fn();
    const c = new ManagedBrowserLeaseController(onExpired);
    c.renew({ ttlMs: TTL });
    c.setInUse(true);
    vi.advanceTimersByTime(TTL * 2);
    expect(onExpired).not.toHaveBeenCalled();
    c.setInUse(false);
    vi.advanceTimersByTime(TTL + 1);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('past the ceiling an in-use lease still expires', () => {
    const onExpired = vi.fn();
    const c = new ManagedBrowserLeaseController(onExpired);
    c.renew({ ttlMs: BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM });
    c.setInUse(true);
    vi.advanceTimersByTime(BROWSER_TIMEOUTS.LEASE_IN_USE_CEILING - 1);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(BROWSER_TIMEOUTS.POOL_IDLE_RECLAIM * 2);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(c.getState()?.status).toBe('expired');
  });

  it('getState lazy expiry respects the flag', () => {
    const onExpired = vi.fn();
    const c = new ManagedBrowserLeaseController(onExpired);
    c.renew({ ttlMs: TTL });
    c.setInUse(true);
    vi.setSystemTime(Date.now() + TTL + 10);
    expect(c.getState()?.status).toBe('active');
    c.setInUse(false);
    vi.setSystemTime(Date.now() + TTL + 10);
    expect(c.getState()?.status).toBe('expired');
  });

  it('heartbeat on an already-expired lease respects the flag', () => {
    const c = new ManagedBrowserLeaseController(vi.fn());
    c.renew({ ttlMs: TTL });
    c.setInUse(true);
    const later = Date.now() + TTL + 10;
    c.heartbeat(later);
    expect(c.getState()?.status).toBe('active');

    const d = new ManagedBrowserLeaseController(vi.fn());
    d.renew({ ttlMs: TTL });
    d.heartbeat(Date.now() + TTL + 10);
    expect(d.getState()?.status).toBe('expired');
  });
});
