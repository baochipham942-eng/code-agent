import { AsyncLocalStorage } from 'node:async_hooks';

interface ScopedCostState {
  readonly maxCostUsd: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usageRecorded: boolean;
  /** 一次本地估算就让整 case 不能冒充 provider 实际 usage。 */
  usageUnavailable: boolean;
  exceeded: boolean;
}

export interface ScopedTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const scopedCostStorage = new AsyncLocalStorage<ScopedCostState>();

class ScopedCostLimitExceededError extends Error {
  readonly code = 'EVAL_CASE_COST_LIMIT_EXCEEDED';

  constructor(
    readonly costUsd: number,
    readonly maxCostUsd: number,
  ) {
    super(
      `成本超限：单 case 实际成本 $${costUsd.toFixed(6)} 超过上限 $${maxCostUsd.toFixed(6)}`,
    );
    this.name = 'ScopedCostLimitExceededError';
  }
}

function assertValidLimit(maxCostUsd: number): void {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error(`max_cost_usd must be a finite number greater than 0, received ${maxCostUsd}`);
  }
}

function throwIfExceeded(state: ScopedCostState): void {
  if (state.exceeded || state.costUsd > state.maxCostUsd) {
    state.exceeded = true;
    throw new ScopedCostLimitExceededError(state.costUsd, state.maxCostUsd);
  }
}

/**
 * 创建一个可跨多轮 sendMessage 复用、且并发隔离的成本上下文。
 * BudgetService 每落一条真实 usage 就会记入当前上下文；越线后立即抛错，
 * 即使下游吞掉该错误，run() 返回前也会再次 fail-loud。
 */
export function createScopedCostLimit(maxCostUsd: number): {
  run<T>(operation: () => Promise<T>): Promise<T>;
  getCostUsd(): number;
  getUsage(): ScopedTokenUsage | undefined;
} {
  assertValidLimit(maxCostUsd);
  const state: ScopedCostState = {
    maxCostUsd,
    costUsd: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usageRecorded: false,
    usageUnavailable: false,
    exceeded: false,
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      return scopedCostStorage.run(state, async () => {
        throwIfExceeded(state);
        const value = await operation();
        throwIfExceeded(state);
        return value;
      });
    },
    getCostUsd(): number {
      return state.costUsd;
    },
    getUsage(): ScopedTokenUsage | undefined {
      if (state.usageUnavailable || !state.usageRecorded) return undefined;
      return {
        promptTokens: state.promptTokens + state.cacheReadTokens + state.cacheCreationTokens,
        completionTokens: state.completionTokens,
        totalTokens: state.promptTokens + state.cacheReadTokens + state.cacheCreationTokens + state.completionTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheCreationTokens: state.cacheCreationTokens,
      };
    },
  };
}

/** BudgetService 的热路径钩子；无 scoped limit 时为零副作用。 */
export function recordScopedCost(costUsd: number): void {
  const state = scopedCostStorage.getStore();
  if (!state) return;
  state.usageRecorded = true;
  state.costUsd += costUsd;
  throwIfExceeded(state);
}

/**
 * 同 scoped USD 一起采集每 case 的 token 原账。estimated usage 只能用于产品内部
 * 预算提示，评测报告必须明确标 usage_unavailable，不能显示成 provider 实际账单。
 */
export function recordScopedUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  source?: 'provider' | 'estimated';
}): void {
  const state = scopedCostStorage.getStore();
  if (!state) return;
  if (usage.source === 'estimated') {
    state.usageUnavailable = true;
    return;
  }
  state.promptTokens += usage.inputTokens;
  state.completionTokens += usage.outputTokens;
  state.cacheReadTokens += usage.cacheReadTokens ?? 0;
  state.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
}

export function isScopedCostLimitExceeded(error: unknown): boolean {
  return error instanceof ScopedCostLimitExceededError
    || (
      typeof error === 'string'
      && (error.includes('EVAL_CASE_COST_LIMIT_EXCEEDED') || error.includes('成本超限：单 case'))
    )
    || (
      error instanceof Error
      && (error.message.includes('EVAL_CASE_COST_LIMIT_EXCEEDED') || error.message.includes('成本超限：单 case'))
    );
}
