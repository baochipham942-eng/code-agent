import type { Client } from '@modelcontextprotocol/client';
import { createLogger } from '../services/infra/logger';
import { MCP_TIMEOUTS } from '../../shared/constants/timeouts';

export interface McpIdleReapingOptions {
  enabled?: boolean;
  ttlMs?: number;
  scanIntervalMs?: number;
}

interface MCPConnectionLease {
  expiresAt?: number;
}

interface McpIdleReaperDependencies {
  clients: ReadonlyMap<string, Client>;
  connectingServers: ReadonlyMap<string, Promise<void>>;
  disconnect: (serverName: string) => Promise<void>;
  now?: () => number;
}

const logger = createLogger('MCPIdleReaper', { lane: 'mcp' });

/** Owns idle-connection bookkeeping and invokes the MCP client's disconnect hook. */
export class McpIdleReaper {
  private readonly clients: ReadonlyMap<string, Client>;
  private readonly connectingServers: ReadonlyMap<string, Promise<void>>;
  private readonly disconnect: (serverName: string) => Promise<void>;
  private readonly now: () => number;
  private idleReapingEnabled = true;
  private idleReapTtlMs: number = MCP_TIMEOUTS.IDLE_REAP_TTL;
  private idleReapScanIntervalMs: number = MCP_TIMEOUTS.IDLE_REAP_SCAN;
  readonly lastUsedAt: Map<string, number> = new Map();
  private readonly activeRequests: Map<string, number> = new Map();
  private readonly connectionLeases: Map<string, Map<string, MCPConnectionLease>> = new Map();
  private readonly reapingServers: Set<string> = new Set();
  private idleReaperTimer: ReturnType<typeof setInterval> | undefined;

  constructor(dependencies: McpIdleReaperDependencies, options?: McpIdleReapingOptions) {
    this.clients = dependencies.clients;
    this.connectingServers = dependencies.connectingServers;
    this.disconnect = dependencies.disconnect;
    this.now = dependencies.now ?? Date.now;
    this.configureIdleReaping(options);
  }

  configureIdleReaping(options?: McpIdleReapingOptions): void {
    this.idleReapingEnabled = options?.enabled ?? true;
    this.idleReapTtlMs = Math.max(1, options?.ttlMs ?? MCP_TIMEOUTS.IDLE_REAP_TTL);
    this.idleReapScanIntervalMs = Math.max(1, options?.scanIntervalMs ?? MCP_TIMEOUTS.IDLE_REAP_SCAN);
    if (this.idleReaperTimer) clearInterval(this.idleReaperTimer);
    this.idleReaperTimer = undefined;
    if (!this.idleReapingEnabled) return;
    this.idleReaperTimer = setInterval(() => {
      void this.reapIdleConnections();
    }, this.idleReapScanIntervalMs);
    (this.idleReaperTimer as unknown as { unref?: () => void }).unref?.();
  }

  private currentTime(): number {
    return this.now();
  }

  touchServer(serverName: string, now = this.currentTime()): void {
    this.lastUsedAt.set(serverName, now);
  }

  beginServerUse(serverName: string): () => void {
    this.touchServer(serverName);
    this.activeRequests.set(serverName, (this.activeRequests.get(serverName) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.activeRequests.get(serverName) ?? 0;
      if (active <= 1) this.activeRequests.delete(serverName);
      else this.activeRequests.set(serverName, active - 1);
      this.touchServer(serverName);
    };
  }

  async withServerUse<T>(serverName: string, operation: () => Promise<T>): Promise<T> {
    const releaseUse = this.beginServerUse(serverName);
    try {
      return await operation();
    } finally {
      releaseUse();
    }
  }

  withExternalClient<T>(
    serverName: string,
    getClient: () => Client | undefined,
    ensureConnected: () => Promise<boolean>,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    return this.withServerUse(serverName, async () => {
      let client = getClient();
      if (!client && await ensureConnected()) client = getClient();
      if (!client) throw new Error(`MCP server ${serverName} not connected`);
      return operation(client);
    });
  }

  private hasValidConnectionLease(serverName: string, now = this.currentTime()): boolean {
    const leases = this.connectionLeases.get(serverName);
    if (!leases || leases.size === 0) return false;
    for (const [leaseId, lease] of leases) {
      if (lease.expiresAt !== undefined && lease.expiresAt <= now) leases.delete(leaseId);
    }
    if (leases.size === 0) this.connectionLeases.delete(serverName);
    return leases.size > 0;
  }

  private isIdleConnection(serverName: string, now = this.currentTime()): boolean {
    if (this.activeRequests.get(serverName)) return false;
    if (this.connectingServers.has(serverName)) return false;
    if (this.hasValidConnectionLease(serverName, now)) return false;
    const lastUsed = this.lastUsedAt.get(serverName);
    return lastUsed !== undefined && now - lastUsed >= this.idleReapTtlMs;
  }

  private async reapIdleConnections(): Promise<void> {
    if (!this.idleReapingEnabled) return;
    const now = this.currentTime();
    for (const [serverName, expectedClient] of this.clients) {
      if (!this.isIdleConnection(serverName, now) || this.reapingServers.has(serverName)) continue;
      this.reapingServers.add(serverName);
      try {
        // Re-check after marking the server. A request started between the scan and
        // this point wins over cleanup and keeps the connection alive.
        if (this.clients.get(serverName) === expectedClient && this.isIdleConnection(serverName, now)) {
          await this.disconnect(serverName);
        }
      } catch (error) {
        logger.warn(`Failed to reap idle MCP server ${serverName}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.reapingServers.delete(serverName);
      }
    }
  }

  acquireConnectionLease(serverName: string, leaseId: string, expiresAt?: number): void {
    let leases = this.connectionLeases.get(serverName);
    if (!leases) {
      leases = new Map();
      this.connectionLeases.set(serverName, leases);
    }
    leases.set(leaseId, { expiresAt });
    this.touchServer(serverName);
  }

  releaseConnectionLease(serverName: string, leaseId: string): void {
    const leases = this.connectionLeases.get(serverName);
    leases?.delete(leaseId);
    if (leases?.size === 0) this.connectionLeases.delete(serverName);
    this.touchServer(serverName);
  }

  clearServer(serverName: string): void {
    this.lastUsedAt.delete(serverName);
    this.activeRequests.delete(serverName);
    this.connectionLeases.delete(serverName);
    this.reapingServers.delete(serverName);
  }

  clearActiveRequests(serverName: string): void {
    this.activeRequests.delete(serverName);
  }

  stop(): void {
    if (this.idleReaperTimer) clearInterval(this.idleReaperTimer);
    this.idleReaperTimer = undefined;
  }
}
