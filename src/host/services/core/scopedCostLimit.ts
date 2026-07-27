import { AsyncLocalStorage } from 'node:async_hooks';

interface ScopedCostState {
  readonly maxCostUsd: number;
  costUsd: number;
  exceeded: boolean;
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
} {
  assertValidLimit(maxCostUsd);
  const state: ScopedCostState = { maxCostUsd, costUsd: 0, exceeded: false };
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
  };
}

/** BudgetService 的热路径钩子；无 scoped limit 时为零副作用。 */
export function recordScopedCost(costUsd: number): void {
  const state = scopedCostStorage.getStore();
  if (!state) return;
  state.costUsd += costUsd;
  throwIfExceeded(state);
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
