// ============================================================================
// 付费生成 commandId 幂等注册表（WP3-1 成本安全）。
//
// 防的是「自动重试/重放路径重复计费」：引擎轮询超时重提、repair 循环、事件重放会把
// 同一条已确认的付费生成命令再次送进 host 收口。同 commandId 已有成功结果时直接返回
// 缓存产物，不再发起付费 API 调用；in-flight 并发同 commandId 合并到同一次执行。
//
// 语义边界：
//   - commandId 在 generationCostConfirm 闸后铸造——一次人工确认 = 一个 commandId。
//     用户刻意重生成会走新确认 → 新 commandId → 正常计费，不会被误挡。
//   - 失败不缓存（重试不该被锁死）；只缓存成功结果。
//   - validate 钩子校验缓存产物仍有效（如落盘文件还在），失效则重新执行。
//   - 有界 + TTL：防内存无界增长；进程内存活即可覆盖自动重放窗口（崩溃恢复不重执行工具）。
// ============================================================================
import { GENERATION_IDEMPOTENCY } from '../../../shared/constants';

interface CachedResult {
  value: unknown;
  expiresAt: number;
}

export class GenerationIdempotencyRegistry {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  /** 成功结果缓存（Map 迭代序 = 插入序，超容量逐出最旧）。 */
  private readonly results = new Map<string, CachedResult>();
  /** 执行中的命令：并发同 commandId 合并到同一 promise，防双重提交。 */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.maxEntries = opts?.maxEntries ?? GENERATION_IDEMPOTENCY.MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? GENERATION_IDEMPOTENCY.TTL_MS;
  }

  async run<T>(
    commandId: string | undefined,
    exec: () => Promise<T>,
    validate?: (cached: T) => Promise<boolean> | boolean,
  ): Promise<T> {
    if (!commandId) return exec();

    const cached = this.results.get(commandId);
    if (cached) {
      if (cached.expiresAt > Date.now() && (!validate || (await validate(cached.value as T)))) {
        return cached.value as T;
      }
      this.results.delete(commandId);
    }

    const running = this.inflight.get(commandId);
    if (running) return running as Promise<T>;

    const promise = exec().then((value) => {
      this.results.set(commandId, { value, expiresAt: Date.now() + this.ttlMs });
      while (this.results.size > this.maxEntries) {
        const oldest = this.results.keys().next().value;
        if (oldest === undefined) break;
        this.results.delete(oldest);
      }
      return value;
    });
    this.inflight.set(commandId, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(commandId);
    }
  }
}

/** 设计/媒体付费生成链路共享单例（image/video/music/slides 四收口对称使用）。 */
export const designGenerationIdempotency = new GenerationIdempotencyRegistry();
