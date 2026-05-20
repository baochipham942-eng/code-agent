import type { ManagedBrowserLeaseState } from '../../../../shared/contract/desktop';
import {
  createManagedBrowserLease,
  isManagedBrowserLeaseExpired,
} from './managedBrowserHelpers';

export class ManagedBrowserLeaseController {
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

  heartbeat(nowMs = Date.now()): void {
    if (this.lease?.status !== 'active') {
      return;
    }
    if (isManagedBrowserLeaseExpired(this.lease, nowMs)) {
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
    if (this.lease.status === 'active' && isManagedBrowserLeaseExpired(this.lease)) {
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
