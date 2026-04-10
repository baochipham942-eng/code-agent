// ============================================================================
// Batch Shadow Evaluator — V3-γ Multi-Eval Parallelism
//
// 批量评估多个 proposal，共享全局信号（regression gate + attribution）
// 以避免重复计算。每个 proposal 的 conflict scan 仍然独立执行。
// ============================================================================

import {
  ShadowEvaluator,
  type ShadowEvaluatorDeps,
} from './shadowEvaluator';
import type { Proposal, ShadowEvalResult } from './proposalTypes';

const DEFAULT_CONCURRENCY = 3;

/** 简易信号量，与 parallelRegressionRunner 同一实现模式 */
function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      const resolve = queue.shift()!;
      resolve();
    }
  }

  return <T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };

      if (active < concurrency) {
        active++;
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

export interface BatchEvalOptions {
  concurrency?: number;
}

export interface BatchEvalResult {
  proposal: Proposal;
  result: ShadowEvalResult;
}

/**
 * 批量评估 proposals：
 * - regression gate 全局共享（只运行一次）
 * - attribution categories 全局共享（只读一次）
 * - conflict scan 每个 proposal 独立运行（受并发度控制）
 */
export async function evaluateBatch(
  proposals: Proposal[],
  deps: ShadowEvaluatorDeps,
  opts: BatchEvalOptions = {},
): Promise<BatchEvalResult[]> {
  if (proposals.length === 0) return [];

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  // 全局信号：只运行一次，所有 proposal 共享
  const [sharedGateDecision, sharedCategoryCounts] = await Promise.all([
    deps.runRegressionGate(),
    deps.readAttributionCategories(),
  ]);

  const limit = pLimit(concurrency);

  const results = await Promise.all(
    proposals.map((proposal) =>
      limit(async () => {
        // 创建一个共享全局信号的 evaluator：
        // - scanConflicts: 每个 proposal 独立
        // - readAttributionCategories: 返回已缓存结果
        // - runRegressionGate: 返回已缓存结果
        const perProposalEvaluator = new ShadowEvaluator({
          scanConflicts: deps.scanConflicts,
          readAttributionCategories: () => Promise.resolve(sharedCategoryCounts),
          runRegressionGate: () => Promise.resolve(sharedGateDecision),
        });

        const result = await perProposalEvaluator.evaluate(proposal);
        return { proposal, result };
      }),
    ),
  );

  return results;
}
