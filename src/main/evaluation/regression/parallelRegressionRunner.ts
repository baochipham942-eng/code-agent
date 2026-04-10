// ============================================================================
// Parallel Regression Runner — V3-γ Multi-Eval Parallelism
//
// 并发执行回归测试 case，通过信号量控制并发度。
// 与 regressionRunner 相同的 RegressionReport 返回类型。
// ============================================================================

import { randomUUID } from 'node:crypto';
import { loadAllCases } from './caseLoader';
import { runOne, filterCasesByCategory } from './regressionRunner';
import type { CaseResult, RegressionReport } from './regressionTypes';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;

export interface ParallelRunOptions {
  timeoutMs?: number;
  concurrency?: number;
  /** 只运行 categories 与此集合有交集的 case */
  filterCategories?: string[];
}

/**
 * 简易信号量：限制同时运行的异步任务数量。
 * 不引入外部依赖，~20 行自实现 pLimit。
 */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
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

export async function runRegressionParallel(
  casesDir: string,
  opts: ParallelRunOptions = {},
): Promise<RegressionReport> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const allCases = await loadAllCases(casesDir);
  const cases = filterCasesByCategory(allCases, opts.filterCategories);
  const startedAt = Date.now();

  const limit = pLimit(concurrency);
  const results: CaseResult[] = await Promise.all(
    cases.map((c) => limit(() => runOne(c, timeoutMs))),
  );

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const errored = results.filter((r) => r.status === 'error').length;

  return {
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    totalCases: cases.length,
    passed,
    failed,
    errored,
    passRate: cases.length === 0 ? 0 : passed / cases.length,
    results,
    durationMs: Date.now() - startedAt,
  };
}
