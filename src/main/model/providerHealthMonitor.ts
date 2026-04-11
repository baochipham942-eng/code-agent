// ============================================================================
// Provider Health Monitor - 追踪请求延迟和错误率
// 纯事件驱动，无后台线程
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('ProviderHealthMonitor');

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'recovering';

export interface ProviderHealth {
  provider: string;
  status: HealthStatus;
  latencyP50: number;
  latencyP95: number;
  errorRate: number;         // 0-1, last 5 minutes
  lastSuccessAt: number;
  lastErrorAt: number;
  consecutiveErrors: number;
}

const WINDOW_SIZE = 10;              // last 10 requests for latency
const ERROR_WINDOW_MS = 5 * 60_000; // 5 minutes for error rate
const DEGRADED_THRESHOLD = 0.3;     // 30% error rate
const UNAVAILABLE_THRESHOLD = 0.7;  // 70% error rate
const RECOVERY_SUCCESS_COUNT = 3;   // consecutive successes to recover

interface ProviderState {
  latencies: number[];
  events: Array<{ time: number; success: boolean }>;
  consecutiveErrors: number;
  consecutiveSuccesses: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  status: HealthStatus;
}

class ProviderHealthMonitor {
  private providers = new Map<string, ProviderState>();

  /** Call after each successful request */
  recordSuccess(provider: string, latencyMs: number): void {
    const state = this.getOrCreate(provider);
    state.latencies.push(latencyMs);
    if (state.latencies.length > WINDOW_SIZE) state.latencies.shift();
    state.events.push({ time: Date.now(), success: true });
    state.consecutiveErrors = 0;
    state.consecutiveSuccesses++;
    state.lastSuccessAt = Date.now();
    this.pruneEvents(state);
    this.updateStatus(provider, state);
  }

  /** Call after each failed request */
  recordFailure(provider: string): void {
    const state = this.getOrCreate(provider);
    state.events.push({ time: Date.now(), success: false });
    state.consecutiveErrors++;
    state.consecutiveSuccesses = 0;
    state.lastErrorAt = Date.now();
    this.pruneEvents(state);
    this.updateStatus(provider, state);
  }

  /** Get health for all providers */
  getHealthMap(): Map<string, ProviderHealth> {
    const result = new Map<string, ProviderHealth>();
    for (const [name, state] of this.providers) {
      result.set(name, this.buildHealth(name, state));
    }
    return result;
  }

  /** Get health for one provider */
  getHealth(provider: string): ProviderHealth | null {
    const state = this.providers.get(provider);
    if (!state) return null;
    return this.buildHealth(provider, state);
  }

  private buildHealth(provider: string, state: ProviderState): ProviderHealth {
    const sorted = [...state.latencies].sort((a, b) => a - b);
    const p50 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0;
    const p95 = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    return {
      provider,
      status: state.status,
      latencyP50: p50,
      latencyP95: p95,
      errorRate: this.calculateErrorRate(state),
      lastSuccessAt: state.lastSuccessAt,
      lastErrorAt: state.lastErrorAt,
      consecutiveErrors: state.consecutiveErrors,
    };
  }

  private getOrCreate(provider: string): ProviderState {
    let state = this.providers.get(provider);
    if (!state) {
      state = {
        latencies: [],
        events: [],
        consecutiveErrors: 0,
        consecutiveSuccesses: 0,
        lastSuccessAt: 0,
        lastErrorAt: 0,
        status: 'healthy',
      };
      this.providers.set(provider, state);
    }
    return state;
  }

  private pruneEvents(state: ProviderState): void {
    const cutoff = Date.now() - ERROR_WINDOW_MS;
    state.events = state.events.filter(e => e.time > cutoff);
  }

  private calculateErrorRate(state: ProviderState): number {
    if (state.events.length === 0) return 0;
    const errors = state.events.filter(e => !e.success).length;
    return errors / state.events.length;
  }

  private updateStatus(provider: string, state: ProviderState): void {
    const errorRate = this.calculateErrorRate(state);
    const prevStatus = state.status;

    if (errorRate >= UNAVAILABLE_THRESHOLD) {
      state.status = 'unavailable';
    } else if (prevStatus === 'unavailable' && state.consecutiveSuccesses >= RECOVERY_SUCCESS_COUNT) {
      state.status = 'recovering';
    } else if (prevStatus === 'recovering' && errorRate < DEGRADED_THRESHOLD) {
      state.status = 'healthy';
    } else if (prevStatus !== 'unavailable' && prevStatus !== 'recovering' && errorRate >= DEGRADED_THRESHOLD) {
      state.status = 'degraded';
    } else if (prevStatus !== 'unavailable' && prevStatus !== 'recovering') {
      state.status = 'healthy';
    }

    if (prevStatus !== state.status) {
      logger.info(`[${provider}] 健康状态变更: ${prevStatus} → ${state.status} (errorRate=${(errorRate * 100).toFixed(1)}%)`);
    }
  }
}

// Singleton
let instance: ProviderHealthMonitor | null = null;
export function getProviderHealthMonitor(): ProviderHealthMonitor {
  if (!instance) instance = new ProviderHealthMonitor();
  return instance;
}
