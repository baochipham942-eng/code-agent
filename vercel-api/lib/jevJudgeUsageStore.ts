// ============================================================================
// Jev 托管判官（N-JEV-NEO-KEY）用量计数存取 —— store 接口 + postgres / 内存两实现
// ----------------------------------------------------------------------------
// 计数契约（任务书 1）：鉴权 → **原子**消费配额 → 才允许触达上游。任何实现都必须
// 把「查两道限额 + 自增」做成单步原子操作，保证并发下不超发。store 抛错时 handler
// 按 jev_counter_unavailable fail-closed（见 jevJudge.ts），绝不绕过计数打上游。
// 内存实现只给本地开发/测试（JEV_JUDGE_ALLOW_MEMORY_STORE=1），生产必须走 postgres。
// ============================================================================

export interface JevJudgeConsumeInput {
  userId: string;
  /** UTC 日（YYYY-MM-DD）：限额窗口。 */
  day: string;
  /** 本次调用的估算成本（USD），由 handler 按请求体字节数算好传入。 */
  estCostUsd: number;
  /** 每用户每日调用上限。 */
  userCallLimit: number;
  /** 全局每日成本熔断（USD）。 */
  globalCostLimitUsd: number;
}

export type JevJudgeQuotaDecision =
  | { allowed: true }
  | { allowed: false; reason: 'user_daily_limit' | 'global_fuse' };

export interface JevJudgeUsageStore {
  /** 原子消费一次配额：allowed=false 时不得自增（拒绝不计数）。 */
  consume(input: JevJudgeConsumeInput): Promise<JevJudgeQuotaDecision>;
}

interface PostgresClient {
  unsafe: (query: string, parameters: never[]) => Promise<unknown>;
  end: (options?: { timeout?: number }) => Promise<void>;
}

type PostgresFactory = (
  databaseUrl: string,
  options: {
    max: number;
    idle_timeout: number;
    connect_timeout: number;
    prepare: boolean;
  },
) => PostgresClient;

/**
 * postgres 实现：调用迁移 20261025*_jev_judge_usage.sql 里的
 * consume_jev_judge_usage()——单事务内锁行、查两道限额、通过则自增（函数即原子边界）。
 */
export function createPostgresJevJudgeUsageStore(
  databaseUrl: string,
  postgresFactory: PostgresFactory,
): JevJudgeUsageStore {
  return {
    async consume(input) {
      const client = postgresFactory(databaseUrl, {
        max: 1,
        idle_timeout: 20,
        connect_timeout: 5,
        prepare: false,
      });
      try {
        const rows = await client.unsafe(
          'SELECT allowed, reason FROM public.consume_jev_judge_usage($1, $2, $3, $4, $5)',
          [
            input.userId,
            input.day,
            input.estCostUsd,
            input.userCallLimit,
            input.globalCostLimitUsd,
          ] as never[],
        );
        const first = Array.isArray(rows) ? (rows[0] as { allowed?: unknown; reason?: unknown } | undefined) : undefined;
        if (first && first.allowed === true) {
          return { allowed: true };
        }
        if (first && first.allowed === false) {
          return {
            allowed: false,
            reason: first.reason === 'global_fuse' ? 'global_fuse' : 'user_daily_limit',
          };
        }
        throw new Error('consume_jev_judge_usage returned no row');
      } finally {
        await client.end({ timeout: 5 }).catch(() => undefined);
      }
    },
  };
}

/**
 * 内存实现（测试/本地开发）：per-user-per-day 调用数 + 全局 per-day 成本，同步判定。
 * 语义与 SQL 函数一致：先查用户日限，再查全局熔断，通过才同时自增两边。
 */
export function createInMemoryJevJudgeUsageStore(): JevJudgeUsageStore {
  const userCalls = new Map<string, number>();
  const globalCost = new Map<string, number>();
  const globalCalls = new Map<string, number>();
  return {
    async consume(input) {
      const userKey = `${input.userId}|${input.day}`;
      const used = userCalls.get(userKey) ?? 0;
      if (used >= input.userCallLimit) {
        return { allowed: false, reason: 'user_daily_limit' };
      }
      const cost = globalCost.get(input.day) ?? 0;
      if (cost + input.estCostUsd > input.globalCostLimitUsd) {
        return { allowed: false, reason: 'global_fuse' };
      }
      userCalls.set(userKey, used + 1);
      globalCost.set(input.day, cost + input.estCostUsd);
      globalCalls.set(input.day, (globalCalls.get(input.day) ?? 0) + 1);
      return { allowed: true };
    },
  };
}
