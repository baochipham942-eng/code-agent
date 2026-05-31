// ============================================================================
// ConcurrencyGate —— scriptRuntime 全局并发闸（provider-aware）
//
// 限制一次 dynamic-workflow run 同时在途的 agent() 总数（globalMax，默认 16），并按
// 每个 provider 的有效 cap 卡其在途数，防止单个 provider（如 zhipu cap=3）占满全局槽
// 把其他 provider 饿死。
//
// 与 model 层 ConcurrencyLimiter 的关系：provider 级 API 限流已在 inferenceViaAiSdk 内部
// 自动生效（acquire→调用→release）。本 gate【绝不】再 acquire provider limiter（否则同一
// limiter 被双重计数/死锁），只做全局公平分配——按 getEffectiveProviderConcurrency 读到的
// cap 做纯计数判断。两层互补：gate 管全局公平，limiter 管 provider API 保护。
// ============================================================================

import { getEffectiveProviderConcurrency, getProviderConcurrencyKey } from '../../model/concurrencyLimiter';

interface Waiter {
  provider: string;
  cap: number;
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  settled: boolean;
}

export class ConcurrencyGate {
  private inFlight = 0;
  private readonly perProvider = new Map<string, number>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly globalMax: number) {}

  /**
   * 申请一个全局槽。返回一个 release 函数——agent() 执行完（无论成功失败）必须调用一次。
   * signal abort 时：若仍在排队则从队列移除并 reject；已放行的由调用方自己 release。
   */
  acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
    const providerKey = getProviderConcurrencyKey(provider) ?? (provider.trim() || 'unknown');
    const cap = getEffectiveProviderConcurrency(providerKey) ?? this.globalMax;
    return new Promise<() => void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('agent call aborted before admission'));
        return;
      }
      const waiter: Waiter = { provider: providerKey, cap, resolve, reject, settled: false };
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (waiter.settled) return;
            const idx = this.waiters.indexOf(waiter);
            if (idx >= 0) {
              this.waiters.splice(idx, 1);
              waiter.settled = true;
              reject(new Error('agent call aborted while queued'));
            }
          },
          { once: true },
        );
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  private canAdmit(provider: string, cap: number): boolean {
    return this.inFlight < this.globalMax && (this.perProvider.get(provider) ?? 0) < cap;
  }

  private pump(): void {
    // provider-aware：遍历队列，跳过其 provider 已满的 waiter，让其他 provider 先上，
    // 避免队头一个满额 provider（如 zhipu）卡死全队（艾克斯指出的饥饿场景）。
    for (let i = 0; i < this.waiters.length; ) {
      if (this.inFlight >= this.globalMax) break;
      const w = this.waiters[i];
      if (w.settled) {
        this.waiters.splice(i, 1);
        continue;
      }
      if (this.canAdmit(w.provider, w.cap)) {
        this.waiters.splice(i, 1);
        w.settled = true;
        this.inFlight++;
        this.perProvider.set(w.provider, (this.perProvider.get(w.provider) ?? 0) + 1);
        let released = false;
        w.resolve(() => {
          if (released) return;
          released = true;
          this.release(w.provider);
        });
      } else {
        i++;
      }
    }
  }

  private release(provider: string): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.perProvider.set(provider, Math.max(0, (this.perProvider.get(provider) ?? 0) - 1));
    this.pump();
  }

  /** 可观测：当前在途与排队数。 */
  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length };
  }
}
