// ============================================================================
// Provider Health Monitor - 追踪请求延迟和错误率
// 纯事件驱动，无后台线程
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  classifyError,
  resolveAvailabilityFailure,
  type AvailabilityKind,
  type AvailabilityScope,
} from './errorClassifier';

const logger = createLogger('ProviderHealthMonitor');

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'recovering';

const AVAILABILITY_MARK_TTL_MS = 30 * 60_000;

interface AvailabilityMark {
  scope: AvailabilityScope;
  kind: AvailabilityKind;
  at: number;
}

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

/**
 * 路由持久供应商错误（PERSISTENT_PROVIDER_ERROR_PATTERN：401/403/余额）整家打标记用的 kind：
 * 余额归 quota（「余额或额度用完了」），其余归 auth。空内容等非持久失败不打标记，不走这里。
 */
export function persistentProviderMarkKind(message: string): AvailabilityKind {
  return classifyError(message) === 'quota_exhaustion' ? 'quota' : 'auth';
}

interface ProviderState {
  observationCount: number;
  latencies: number[];
  events: Array<{ time: number; success: boolean }>;
  consecutiveErrors: number;
  consecutiveSuccesses: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  status: HealthStatus;
}

function modelKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

class ProviderHealthMonitor {
  private providers = new Map<string, ProviderState>();
  /** 供应商级失败（401/403、余额、网络）：标整家。 */
  private providerMarks = new Map<string, AvailabilityMark>();
  /** 模型级失败（停用 / 不存在）：只标这一个模型。 */
  private modelMarks = new Map<string, AvailabilityMark>();

  /** Call after each successful request */
  recordSuccess(provider: string, latencyMs: number, options?: { model?: string }): void {
    const state = this.getOrCreate(provider);
    state.observationCount++;
    state.latencies.push(latencyMs);
    if (state.latencies.length > WINDOW_SIZE) state.latencies.shift();
    state.events.push({ time: Date.now(), success: true });
    state.consecutiveErrors = 0;
    state.consecutiveSuccesses++;
    state.lastSuccessAt = Date.now();
    this.pruneEvents(state);
    this.updateStatus(provider, state);
    // 成功一次立即清该级标记：这个模型的模型级标记 + 这家的供应商级标记。
    if (options?.model) this.modelMarks.delete(modelKey(provider, options.model));
    this.providerMarks.delete(provider);
  }

  /** Call after each failed request */
  recordFailure(provider: string, options?: {
    cancelled?: boolean;
    model?: string;
    error?: unknown;
    scope?: AvailabilityScope;
    kind?: AvailabilityKind;
  }): void {
    // 用户主动取消不是 provider 故障，不参与健康统计，也不记作成功。
    if (options?.cancelled === true) return;
    const classified = options?.scope && options?.kind
      ? { scope: options.scope, kind: options.kind }
      : resolveAvailabilityFailure(options?.error);
    const at = Date.now();
    if (classified?.scope === 'model' && options?.model) {
      this.modelMarks.set(modelKey(provider, options.model), { scope: 'model', kind: classified.kind, at });
      // 模型级失败不把整家打成 unavailable（Preview 下线不能连累 LongCat-2.0）。
      const state = this.getOrCreate(provider);
      state.observationCount++;
      return;
    }
    if (classified?.scope === 'provider') {
      // 网络类（5xx/断网）一次失败就给整家打 30 分钟标记，会把手机默认模型切到别家且难以
      // 自愈——默认已换走，不再有请求来清标记。所以网络类只在错误率已把健康态推到 unavailable
      // （下面的 updateStatus 沿用 UNAVAILABLE_THRESHOLD 阈值，此刻读的是这笔失败之前的态）
      // 时才升格成供应商级标记；auth/quota 是持久性问题（key 无效/余额耗尽），一次即标。
      const persistent = classified.kind === 'auth' || classified.kind === 'quota';
      if (persistent || this.getOrCreate(provider).status === 'unavailable') {
        this.providerMarks.set(provider, { scope: 'provider', kind: classified.kind, at });
      }
    }
    const state = this.getOrCreate(provider);
    state.observationCount++;
    state.events.push({ time: Date.now(), success: false });
    state.consecutiveErrors++;
    state.consecutiveSuccesses = 0;
    state.lastErrorAt = Date.now();
    this.pruneEvents(state);
    this.updateStatus(provider, state);
  }

  private expired(at: number, now = Date.now()): boolean {
    return now - at >= AVAILABILITY_MARK_TTL_MS;
  }

  getAvailabilityMark(provider: string, model: string): AvailabilityMark | null {
    const now = Date.now();
    const providerMark = this.providerMarks.get(provider);
    if (providerMark && !this.expired(providerMark.at, now)) return providerMark;
    if (providerMark) this.providerMarks.delete(provider);
    const mark = this.modelMarks.get(modelKey(provider, model));
    if (mark && !this.expired(mark.at, now)) return mark;
    if (mark) this.modelMarks.delete(modelKey(provider, model));
    return null;
  }

  getProviderMark(provider: string): AvailabilityMark | null {
    const mark = this.providerMarks.get(provider);
    if (!mark) return null;
    if (this.expired(mark.at)) {
      this.providerMarks.delete(provider);
      return null;
    }
    return mark;
  }

  getModelMarks(provider: string): Record<string, { kind: AvailabilityKind }> {
    const now = Date.now();
    const out: Record<string, { kind: AvailabilityKind }> = {};
    const prefix = `${provider}\0`;
    for (const [key, mark] of this.modelMarks) {
      if (!key.startsWith(prefix)) continue;
      if (this.expired(mark.at, now)) {
        this.modelMarks.delete(key);
        continue;
      }
      out[key.slice(prefix.length)] = { kind: mark.kind };
    }
    return out;
  }

  listKnownProviders(): string[] {
    const names = new Set(this.providers.keys());
    for (const name of this.providerMarks.keys()) names.add(name);
    for (const key of this.modelMarks.keys()) names.add(key.slice(0, key.indexOf('\0')));
    return [...names];
  }

  /**
   * 显示口径的「整家连不上」：健康态被熔断成 unavailable **且最近一次事件是失败**（lastErrorAt 严格晚于
   * lastSuccessAt）。成功一次就清——recordSuccess 已删标记，这里不能还被旧的 unavailable 拖住
   * （RECOVERY_SUCCESS_COUNT 只管路由的恢复节奏；模拟器验收 D1：500×5 后成功 1 次，手机两行仍
   * 「最近连不上」、默认挂到别家，电脑端同时刻新建会话却还是原默认，两端不一致）。
   * 时间戳同毫秒并列算已清：真实调用一轮不可能同毫秒成对出现；会走到这支（无存活标记）的并列，
   * 只可能是成功刚删掉标记——失败若在其后必会再留下标记，就走标记那支了。
   */
  isProviderDown(provider: string): boolean {
    const state = this.providers.get(provider);
    if (!state) return false;
    return state.status === 'unavailable' && state.lastErrorAt > state.lastSuccessAt;
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

  /** Lifetime counter used by outer adapters to fill only genuinely missing observations. */
  getObservationCount(provider: string): number {
    return this.providers.get(provider)?.observationCount ?? 0;
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
        observationCount: 0,
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
