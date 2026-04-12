// ============================================================================
// HeartbeatService - Health check and monitoring service
// ============================================================================

import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserWindow } from '../platform';
import { v4 as uuidv4 } from 'uuid';
import { IPC_CHANNELS } from '../../shared/ipc';
import type {
  HeartbeatConfig,
  HeartbeatStatus,
  HeartbeatCheck,
  HeartbeatExpectation,
} from '../../shared/contract/cron';
import { getDatabase } from '../services/core/databaseService';
import { notificationService } from '../services/infra/notificationService';
import { getToolResolver } from '../tools/toolResolver';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

interface ActiveHeartbeat {
  config: HeartbeatConfig;
  status: HeartbeatStatus;
  intervalId?: NodeJS.Timeout;
  checkHistory: HeartbeatCheckResult[];
}

interface HeartbeatCheckResult {
  timestamp: number;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
}

interface HeartbeatRow {
  id: string;
  name: string;
  interval: number;
  check_config: string;
  expectation: string | null;
  alert: string | null;
  enabled: number;
  failure_threshold: number | null;
  created_at: number;
  updated_at: number;
}

// ============================================================================
// HeartbeatService
// ============================================================================

export class HeartbeatService {
  private heartbeats: Map<string, ActiveHeartbeat> = new Map();
  private isInitialized = false;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Load heartbeats from database
    await this.loadHeartbeatsFromDatabase();

    this.isInitialized = true;
    console.error('[HeartbeatService] Initialized');
  }

  async shutdown(): Promise<void> {
    // Stop all heartbeat checks
    for (const [id, heartbeat] of this.heartbeats) {
      if (heartbeat.intervalId) {
        clearInterval(heartbeat.intervalId);
        console.error(`[HeartbeatService] Stopped heartbeat: ${id}`);
      }
    }

    this.heartbeats.clear();
    this.isInitialized = false;
    console.error('[HeartbeatService] Shutdown complete');
  }

  // --------------------------------------------------------------------------
  // Heartbeat Management
  // --------------------------------------------------------------------------

  /**
   * Create a new heartbeat
   */
  async createHeartbeat(
    config: Omit<HeartbeatConfig, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<HeartbeatConfig> {
    const now = Date.now();
    const heartbeat: HeartbeatConfig = {
      ...config,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const status: HeartbeatStatus = {
      heartbeatId: heartbeat.id,
      status: 'unknown',
      consecutiveFailures: 0,
    };

    // Save to database
    await this.saveHeartbeatToDatabase(heartbeat);

    // Register and start if enabled
    const activeHeartbeat: ActiveHeartbeat = {
      config: heartbeat,
      status,
      checkHistory: [],
    };

    if (heartbeat.enabled) {
      this.startHeartbeat(activeHeartbeat);
    }

    this.heartbeats.set(heartbeat.id, activeHeartbeat);

    return heartbeat;
  }

  /**
   * Update a heartbeat
   */
  async updateHeartbeat(
    id: string,
    updates: Partial<Omit<HeartbeatConfig, 'id' | 'createdAt'>>
  ): Promise<HeartbeatConfig | null> {
    const active = this.heartbeats.get(id);
    if (!active) return null;

    // Stop existing interval
    if (active.intervalId) {
      clearInterval(active.intervalId);
      active.intervalId = undefined;
    }

    const updatedConfig: HeartbeatConfig = {
      ...active.config,
      ...updates,
      updatedAt: Date.now(),
    };

    active.config = updatedConfig;

    // Save to database
    await this.saveHeartbeatToDatabase(updatedConfig);

    // Restart if enabled
    if (updatedConfig.enabled) {
      this.startHeartbeat(active);
    }

    return updatedConfig;
  }

  /**
   * Delete a heartbeat
   */
  async deleteHeartbeat(id: string): Promise<boolean> {
    const active = this.heartbeats.get(id);
    if (!active) return false;

    // Stop interval
    if (active.intervalId) {
      clearInterval(active.intervalId);
    }

    // Remove from memory
    this.heartbeats.delete(id);

    // Remove from database
    await this.deleteHeartbeatFromDatabase(id);

    return true;
  }

  /**
   * Get a heartbeat by ID
   */
  getHeartbeat(id: string): HeartbeatConfig | null {
    return this.heartbeats.get(id)?.config || null;
  }

  /**
   * Get heartbeat status
   */
  getStatus(id: string): HeartbeatStatus | null {
    return this.heartbeats.get(id)?.status || null;
  }

  /**
   * List all heartbeats
   */
  listHeartbeats(): HeartbeatConfig[] {
    return Array.from(this.heartbeats.values()).map((h) => h.config);
  }

  /**
   * List all heartbeat statuses
   */
  listStatuses(): HeartbeatStatus[] {
    return Array.from(this.heartbeats.values()).map((h) => h.status);
  }

  /**
   * Enable a heartbeat
   */
  async enableHeartbeat(id: string): Promise<boolean> {
    const updated = await this.updateHeartbeat(id, { enabled: true });
    return !!updated;
  }

  /**
   * Disable a heartbeat
   */
  async disableHeartbeat(id: string): Promise<boolean> {
    const updated = await this.updateHeartbeat(id, { enabled: false });
    return !!updated;
  }

  /**
   * Trigger an immediate check
   */
  async triggerCheck(id: string): Promise<HeartbeatCheckResult | null> {
    const active = this.heartbeats.get(id);
    if (!active) return null;

    return this.runCheck(active);
  }

  /**
   * Get check history
   */
  getCheckHistory(id: string, limit: number = 100): HeartbeatCheckResult[] {
    const active = this.heartbeats.get(id);
    if (!active) return [];

    return active.checkHistory.slice(-limit);
  }

  // --------------------------------------------------------------------------
  // Convenience Methods
  // --------------------------------------------------------------------------

  /**
   * Create a shell-based heartbeat
   */
  async createShellHeartbeat(
    command: string,
    interval: number,
    options?: {
      name?: string;
      cwd?: string;
      expectedExitCode?: number;
      failureThreshold?: number;
    }
  ): Promise<HeartbeatConfig> {
    return this.createHeartbeat({
      name: options?.name || `Shell: ${command.substring(0, 30)}`,
      interval,
      check: {
        type: 'shell',
        command,
        cwd: options?.cwd,
        expectedExitCode: options?.expectedExitCode,
      },
      enabled: true,
      failureThreshold: options?.failureThreshold || 3,
    });
  }

  /**
   * Create an HTTP health check
   */
  async createHttpHeartbeat(
    url: string,
    interval: number,
    options?: {
      name?: string;
      method?: 'GET' | 'HEAD' | 'POST';
      expectedStatus?: number | number[];
      timeout?: number;
      failureThreshold?: number;
    }
  ): Promise<HeartbeatConfig> {
    return this.createHeartbeat({
      name: options?.name || `HTTP: ${new URL(url).hostname}`,
      interval,
      check: {
        type: 'http',
        url,
        method: options?.method || 'GET',
        expectedStatus: options?.expectedStatus || 200,
        timeout: options?.timeout || 5000,
      },
      enabled: true,
      failureThreshold: options?.failureThreshold || 3,
    });
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get heartbeat statistics
   */
  getStats(): {
    total: number;
    enabled: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
    averageUptime: number;
  } {
    const heartbeats = Array.from(this.heartbeats.values());
    const statuses = heartbeats.map((h) => h.status);

    return {
      total: heartbeats.length,
      enabled: heartbeats.filter((h) => h.config.enabled).length,
      healthy: statuses.filter((s) => s.status === 'healthy').length,
      unhealthy: statuses.filter((s) => s.status === 'unhealthy').length,
      unknown: statuses.filter((s) => s.status === 'unknown').length,
      averageUptime:
        statuses.reduce((acc, s) => acc + (s.uptimePercentage || 0), 0) /
        (statuses.length || 1),
    };
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private startHeartbeat(active: ActiveHeartbeat): void {
    const { config } = active;

    // Run initial check
    this.runCheck(active).catch((err) =>
      console.error(`[HeartbeatService] Initial check failed for ${config.id}:`, err)
    );

    // Start interval
    active.intervalId = setInterval(() => {
      this.runCheck(active).catch((err) =>
        console.error(`[HeartbeatService] Check failed for ${config.id}:`, err)
      );
    }, config.interval);

    console.error(
      `[HeartbeatService] Started heartbeat: ${config.name} (every ${config.interval}ms)`
    );
  }

  private async runCheck(active: ActiveHeartbeat): Promise<HeartbeatCheckResult> {
    const { config, status } = active;
    const startTime = Date.now();

    let success = false;
    let output: string | undefined;
    let error: string | undefined;

    try {
      const result = await this.executeCheck(config.check);
      output = result.output;

      // Check expectation if defined
      if (config.expectation) {
        success = this.checkExpectation(output, config.expectation);
      } else {
        success = result.success;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      success = false;
    }

    const duration = Date.now() - startTime;

    const checkResult: HeartbeatCheckResult = {
      timestamp: startTime,
      success,
      duration,
      output,
      error,
    };

    // Update history (keep last 1000 checks)
    active.checkHistory.push(checkResult);
    if (active.checkHistory.length > 1000) {
      active.checkHistory = active.checkHistory.slice(-1000);
    }

    // Update status
    status.lastCheckAt = startTime;
    if (success) {
      status.status = 'healthy';
      status.lastSuccessAt = startTime;
      status.consecutiveFailures = 0;
      status.lastError = undefined;
    } else {
      status.consecutiveFailures++;
      status.lastFailureAt = startTime;
      status.lastError = error;

      if (status.consecutiveFailures >= (config.failureThreshold || 1)) {
        status.status = 'unhealthy';

        // Trigger alert if configured
        if (config.alert) {
          await this.triggerAlert(config, status, checkResult);
        }
      }
    }

    // Calculate uptime percentage (last 24 hours)
    const last24h = active.checkHistory.filter(
      (c) => c.timestamp > Date.now() - 24 * 60 * 60 * 1000
    );
    if (last24h.length > 0) {
      status.uptimePercentage =
        (last24h.filter((c) => c.success).length / last24h.length) * 100;
    }

    return checkResult;
  }

  private async executeCheck(
    check: HeartbeatCheck
  ): Promise<{ success: boolean; output: string }> {
    switch (check.type) {
      case 'shell': {
        try {
          const { stdout, stderr } = await execAsync(check.command, {
            cwd: check.cwd,
            timeout: 30000,
          });
          const output = stdout + (stderr ? `\n[stderr]: ${stderr}` : '');
          // If expectedExitCode is specified, we already know it succeeded (didn't throw)
          return { success: true, output };
        } catch (err: unknown) {
          const error = err as { code?: number; stdout?: string; stderr?: string; message?: string };
          if (check.expectedExitCode !== undefined && error.code === check.expectedExitCode) {
            return { success: true, output: error.stdout || '' };
          }
          throw new Error(error.message || 'Command failed');
        }
      }

      case 'http': {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), check.timeout || 5000);

        try {
          const response = await fetch(check.url, {
            method: check.method || 'GET',
            headers: check.headers,
            signal: controller.signal,
          });

          const body = await response.text();

          const expectedStatuses = Array.isArray(check.expectedStatus)
            ? check.expectedStatus
            : [check.expectedStatus || 200];

          const success = expectedStatuses.includes(response.status);

          return { success, output: body };
        } finally {
          clearTimeout(timeout);
        }
      }

      case 'tool': {
        const resolver = getToolResolver();
        const toolDef = resolver.getDefinition(check.toolName);

        if (!toolDef) {
          return {
            success: false,
            output: `Tool "${check.toolName}" is not registered`,
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            toolName: check.toolName,
            registered: true,
            description: toolDef.description,
            requiresPermission: toolDef.requiresPermission,
            parameters: check.parameters ?? {},
          }),
        };
      }

      default:
        throw new Error('Unknown check type');
    }
  }

  private checkExpectation(output: string, expectation: HeartbeatExpectation): boolean {
    if (expectation.equals !== undefined) {
      return output === expectation.equals;
    }

    if (expectation.contains !== undefined) {
      return output.includes(expectation.contains);
    }

    if (expectation.matches !== undefined) {
      const regex = new RegExp(expectation.matches);
      return regex.test(output);
    }

    // Note: customValidator support removed for security reasons
    // Custom validation should be implemented through tool-based checks instead

    return true;
  }

  private async triggerAlert(
    config: HeartbeatConfig,
    status: HeartbeatStatus,
    checkResult: HeartbeatCheckResult
  ): Promise<void> {
    const { alert } = config;
    if (!alert) return;

    console.warn(
      `[HeartbeatService] Alert triggered for ${config.name}: ${checkResult.error || 'Check failed'}`
    );

    if (alert.ipc) {
      const event = {
        type: 'notification' as const,
        data: {
          message: `[Heartbeat] ${config.name}: ${checkResult.error || 'Check failed'}`,
          heartbeatId: config.id,
          status: status.status,
          consecutiveFailures: status.consecutiveFailures,
        },
      };

      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_CHANNELS.AGENT_EVENT, event);
      }
    }

    if (alert.notification) {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_CHANNELS.AGENT_EVENT, {
          type: 'notification',
          data: {
            message: `[Heartbeat Alert] ${config.name} is ${status.status}`,
            heartbeatId: config.id,
          },
        });
      }

      notificationService.notifyTaskComplete({
        sessionId: config.id,
        sessionTitle: `Heartbeat Alert: ${config.name}`,
        summary: checkResult.error || `Heartbeat is ${status.status}`,
        duration: checkResult.duration,
        toolsUsed: config.check.type === 'tool' ? [config.check.toolName] : [],
      });
    }

    if (alert.webhook) {
      try {
        await fetch(alert.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            heartbeat: config.name,
            status: status.status,
            consecutiveFailures: status.consecutiveFailures,
            lastError: status.lastError,
            timestamp: Date.now(),
          }),
        });
      } catch (err) {
        console.error('[HeartbeatService] Failed to send webhook alert:', err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Database Operations
  // --------------------------------------------------------------------------

  private async loadHeartbeatsFromDatabase(): Promise<void> {
    try {
      const db = await this.getRawDatabase();
      const rows = db
        .prepare(`
          SELECT
            id,
            name,
            interval,
            check_config,
            expectation,
            alert,
            enabled,
            failure_threshold,
            created_at,
            updated_at
          FROM heartbeats
        `)
        .all() as HeartbeatRow[];

      for (const row of rows) {
        const config: HeartbeatConfig = {
          id: row.id,
          name: row.name,
          interval: row.interval,
          check: JSON.parse(row.check_config) as HeartbeatCheck,
          expectation: row.expectation ? JSON.parse(row.expectation) as HeartbeatExpectation : undefined,
          alert: row.alert ? JSON.parse(row.alert) : undefined,
          enabled: row.enabled === 1,
          failureThreshold: row.failure_threshold ?? 3,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };

        const activeHeartbeat: ActiveHeartbeat = {
          config,
          status: {
            heartbeatId: config.id,
            status: 'unknown',
            consecutiveFailures: 0,
          },
          checkHistory: [],
        };

        if (config.enabled) {
          this.startHeartbeat(activeHeartbeat);
        }

        this.heartbeats.set(config.id, activeHeartbeat);
      }
    } catch (error) {
      console.error('[HeartbeatService] Failed to load heartbeats from database:', error);
    }
  }

  private async saveHeartbeatToDatabase(config: HeartbeatConfig): Promise<void> {
    try {
      const db = await this.getRawDatabase();
      db.prepare(`
        INSERT INTO heartbeats (
          id,
          name,
          interval,
          check_config,
          expectation,
          alert,
          enabled,
          failure_threshold,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @name,
          @interval,
          @check_config,
          @expectation,
          @alert,
          @enabled,
          @failure_threshold,
          @created_at,
          @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          interval = excluded.interval,
          check_config = excluded.check_config,
          expectation = excluded.expectation,
          alert = excluded.alert,
          enabled = excluded.enabled,
          failure_threshold = excluded.failure_threshold,
          updated_at = excluded.updated_at
      `).run({
        id: config.id,
        name: config.name,
        interval: config.interval,
        check_config: JSON.stringify(config.check),
        expectation: config.expectation ? JSON.stringify(config.expectation) : null,
        alert: config.alert ? JSON.stringify(config.alert) : null,
        enabled: config.enabled ? 1 : 0,
        failure_threshold: config.failureThreshold ?? 3,
        created_at: config.createdAt,
        updated_at: config.updatedAt,
      });
    } catch (error) {
      console.error('[HeartbeatService] Failed to save heartbeat to database:', error);
    }
  }

  private async deleteHeartbeatFromDatabase(id: string): Promise<void> {
    try {
      const db = await this.getRawDatabase();
      db.prepare('DELETE FROM heartbeats WHERE id = ?').run(id);
    } catch (error) {
      console.error('[HeartbeatService] Failed to delete heartbeat from database:', error);
    }
  }

  private async getRawDatabase() {
    const databaseService = getDatabase();
    if (!databaseService.isReady) {
      await databaseService.initialize();
    }

    const db = databaseService.getDb();
    if (!db) {
      throw new Error('Database not initialized');
    }

    return db;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let heartbeatServiceInstance: HeartbeatService | null = null;

export function getHeartbeatService(): HeartbeatService {
  if (!heartbeatServiceInstance) {
    heartbeatServiceInstance = new HeartbeatService();
  }
  return heartbeatServiceInstance;
}

export async function initHeartbeatService(): Promise<HeartbeatService> {
  const service = getHeartbeatService();
  await service.initialize();
  return service;
}
