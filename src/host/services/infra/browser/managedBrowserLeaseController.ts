import type { ManagedBrowserLeaseState } from '../../../../shared/contract/desktop';
import { BROWSER_TIMEOUTS } from '../../../../shared/constants/timeouts';
import { createLogger } from '../logger';
import {
  createManagedBrowserLease,
  isManagedBrowserLeaseExpired,
} from './managedBrowserHelpers';

const logger = createLogger('ManagedBrowserLease');

export class ManagedBrowserLeaseController {
  private inUse = false;
  private lease: ManagedBrowserLeaseState | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onExpired: (lease: ManagedBrowserLeaseState) => void) {}

  renew(args: { owner?: string; ttlMs?: number } = {}): ManagedBrowserLeaseState {
    const nowMs = Date.now();
    const lease = createManagedBrowserLease({
      owner: args.owner || this.lease?.owner || 'managed-browser',
      ttlMs: args.ttlMs,
      nowMs,
      leaseId: this.lease?.status === 'active' ? this.lease.leaseId : undefined,
      acquiredAtMs: this.lease?.status === 'active' ? this.lease.acquiredAtMs : undefined,
    });
    this.lease = lease;
    this.scheduleExpiry(lease);
    return lease;
  }

  setInUse(inUse: boolean): void {
    this.inUse = inUse;
  }

  heartbeat(nowMs = Date.now()): void {
    if (this.lease?.status !== 'active') {
      return;
    }
    if (isManagedBrowserLeaseExpired(this.lease, nowMs) && !this.extendIfInUse(nowMs)) {
      this.markExpired(nowMs);
      return;
    }
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: nowMs + this.lease.ttlMs,
    };
    this.scheduleExpiry(this.lease);
  }

  release(nowMs = Date.now()): void {
    this.clearTimer();
    if (!this.lease) {
      return;
    }
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: nowMs,
      status: 'released',
    };
  }

  getState(): ManagedBrowserLeaseState | null {
    if (!this.lease) {
      return null;
    }
    if (
      this.lease.status === 'active'
      && isManagedBrowserLeaseExpired(this.lease)
      && !this.extendIfInUse(Date.now())
    ) {
      this.markExpired();
    }
    return this.lease ? { ...this.lease } : null;
  }

  markExpired(nowMs: number = Date.now()): void {
    this.clearTimer();
    if (!this.lease) {
      return;
    }
    this.lease = {
      ...this.lease,
      lastHeartbeatAtMs: nowMs,
      expiresAtMs: Math.min(this.lease.expiresAtMs, nowMs),
      status: 'expired',
    };
  }

  /** An in-use binding keeps its lease past the TTL until the ceiling since the last heartbeat. */
  private extendIfInUse(nowMs: number): boolean {
    const lease = this.lease;
    if (!this.inUse || lease?.status !== 'active') {
      return false;
    }
    if (nowMs - lease.lastHeartbeatAtMs >= BROWSER_TIMEOUTS.LEASE_IN_USE_CEILING) {
      return false;
    }
    this.lease = { ...lease, expiresAtMs: nowMs + lease.ttlMs };
    logger.warn(`Managed browser lease ${lease.leaseId} is in use; extended instead of expiring.`);
    this.scheduleExpiry(this.lease);
    return true;
  }

  private scheduleExpiry(lease: ManagedBrowserLeaseState): void {
    this.clearTimer();
    if (lease.status !== 'active') {
      return;
    }
    const delayMs = Math.max(0, lease.expiresAtMs - Date.now());
    this.leaseTimer = setTimeout(() => {
      if (this.lease?.leaseId !== lease.leaseId || this.lease.status !== 'active') {
        return;
      }
      if (this.extendIfInUse(Date.now())) {
        return;
      }
      this.markExpired();
      this.onExpired(lease);
    }, delayMs);
    this.leaseTimer.unref?.();
  }

  private clearTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
    }
  }
}
