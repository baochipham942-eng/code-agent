// ============================================================================
// SwarmReconcile（ADR-022 §四第三期 3b · ADR-023 D2「影子对账」）
//
// 逐字段比对"从 ledger 重建出的 rollup"与"现存 rollup 表"，证明 append-only 账本
// 捕获齐全、可当真理源。drift 为空 = 两边讲同一个故事，可放心切换降级。
// parallelPeak 允许小偏差（运行时动态 vs 事件统计），costUsd 用浮点 epsilon。
// 纯函数、零 DB。
// ============================================================================

import type { SwarmRunDetail } from '../../../shared/contract/swarmTrace';

export interface ReconcileDrift {
  /** 'run' 或 `agent:<id>` */
  scope: string;
  field: string;
  rebuilt: unknown;
  stored: unknown;
  /** true=在容忍阈值内（不计入 match 失败） */
  tolerated?: boolean;
}

export interface ReconcileResult {
  runId: string;
  match: boolean;
  drift: ReconcileDrift[];
  /** 缺一边时的说明（如 ledger 无该 run，或 rollup 表无该 run） */
  note?: string;
}

export interface ReconcileOptions {
  parallelPeakTolerance?: number;
  costEpsilon?: number;
}

function numEq(a: number, b: number, eps = 0): boolean {
  return Math.abs(a - b) <= eps;
}

/**
 * 对账「重建 vs 现存」。任一为 null（缺账或缺表）→ match=false + note。
 */
export function reconcileRun(
  rebuilt: SwarmRunDetail | null,
  stored: SwarmRunDetail | null,
  runId: string,
  options: ReconcileOptions = {},
): ReconcileResult {
  const peakTol = options.parallelPeakTolerance ?? 1;
  const costEps = options.costEpsilon ?? 1e-9;

  if (!rebuilt && !stored) return { runId, match: false, drift: [], note: 'both-missing' };
  if (!rebuilt) return { runId, match: false, drift: [], note: 'ledger-missing' };
  if (!stored) return { runId, match: false, drift: [], note: 'rollup-missing' };

  const drift: ReconcileDrift[] = [];
  const push = (scope: string, field: string, r: unknown, s: unknown, tolerated = false) =>
    drift.push({ scope, field, rebuilt: r, stored: s, tolerated });

  const R = rebuilt.run, S = stored.run;
  // run 级精确比对字段
  if (R.status !== S.status) push('run', 'status', R.status, S.status);
  if (R.startedAt !== S.startedAt) push('run', 'startedAt', R.startedAt, S.startedAt);
  if (R.endedAt !== S.endedAt) push('run', 'endedAt', R.endedAt, S.endedAt);
  if (R.totalAgents !== S.totalAgents) push('run', 'totalAgents', R.totalAgents, S.totalAgents);
  if (R.completedCount !== S.completedCount) push('run', 'completedCount', R.completedCount, S.completedCount);
  if (R.failedCount !== S.failedCount) push('run', 'failedCount', R.failedCount, S.failedCount);
  if (R.totalTokensIn !== S.totalTokensIn) push('run', 'totalTokensIn', R.totalTokensIn, S.totalTokensIn);
  if (R.totalTokensOut !== S.totalTokensOut) push('run', 'totalTokensOut', R.totalTokensOut, S.totalTokensOut);
  if (R.totalToolCalls !== S.totalToolCalls) push('run', 'totalToolCalls', R.totalToolCalls, S.totalToolCalls);
  if (!numEq(R.totalCostUsd, S.totalCostUsd, costEps)) push('run', 'totalCostUsd', R.totalCostUsd, S.totalCostUsd);
  // parallelPeak：容忍小偏差（运行时动态 vs 事件统计）
  if (R.parallelPeak !== S.parallelPeak) {
    push('run', 'parallelPeak', R.parallelPeak, S.parallelPeak, numEq(R.parallelPeak, S.parallelPeak, peakTol));
  }

  // agent 级比对（按 agentId 对齐）
  const storedById = new Map(stored.agents.map((a) => [a.agentId, a]));
  const seen = new Set<string>();
  for (const ra of rebuilt.agents) {
    seen.add(ra.agentId);
    const sa = storedById.get(ra.agentId);
    const scope = `agent:${ra.agentId}`;
    if (!sa) { push(scope, 'presence', 'present', 'missing'); continue; }
    if (ra.status !== sa.status) push(scope, 'status', ra.status, sa.status);
    if (ra.tokensIn !== sa.tokensIn) push(scope, 'tokensIn', ra.tokensIn, sa.tokensIn);
    if (ra.tokensOut !== sa.tokensOut) push(scope, 'tokensOut', ra.tokensOut, sa.tokensOut);
    if (ra.toolCalls !== sa.toolCalls) push(scope, 'toolCalls', ra.toolCalls, sa.toolCalls);
    if (!numEq(ra.costUsd, sa.costUsd, costEps)) push(scope, 'costUsd', ra.costUsd, sa.costUsd);
    if ((ra.error ?? null) !== (sa.error ?? null)) push(scope, 'error', ra.error, sa.error);
  }
  for (const sa of stored.agents) {
    if (!seen.has(sa.agentId)) push(`agent:${sa.agentId}`, 'presence', 'missing', 'present');
  }

  const match = drift.every((d) => d.tolerated);
  return { runId, match, drift };
}
