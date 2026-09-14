// eval-core-summary —— core 集周跑的摘要与模型漂移比对（N-EVAL-CORESET-CRON）。
// 纯函数：输入两份 eval-ci 报告 JSON（generateJsonReport 产物），不读盘不打印，供 scripts/eval-core-summary.mjs 与单测用。

/** 被测/裁判身份：与 TrendDataPoint.model 同口径（provider/model[@endpoint]），裁判取 stamp.scorers.judgeModel。 */
export function reportIdentity(report) {
  const env = report?.environment ?? {};
  const subject = `${env.provider ?? 'unknown'}/${env.model ?? 'unknown'}${env.endpoint ? `@${env.endpoint}` : ''}`;
  return { subject, judge: report?.stamp?.scorers?.judgeModel ?? 'unknown' };
}

/**
 * 模型漂移：被测或裁判任一变了就点名。返回 null = 没变或没有上一轮可比。
 * 这是课程「服务商升级=触发式回归」在桌面产品里的唯一可行形态——探不到升级，只能记录每轮用了谁。
 */
export function detectModelDrift(previous, current) {
  if (!previous) return null;
  const before = reportIdentity(previous);
  const after = reportIdentity(current);
  const changed = [];
  if (before.subject !== after.subject) changed.push(`被测模型已变：${before.subject} → ${after.subject}`);
  if (before.judge !== after.judge) changed.push(`裁判模型已变：${before.judge} → ${after.judge}`);
  return changed.length ? changed.join('；') : null;
}

/** 与 eval-ci 同口径的能力通过率：环境故障、成本超限、跳过不进分母；not_run 留在分母里。 */
export function capabilityPassRate(report) {
  const denominator = (report.total ?? 0) - (report.infraExcluded ?? 0) - (report.costExceeded ?? 0) - (report.skipped ?? 0);
  return denominator > 0 ? (report.passed ?? 0) / denominator : 0;
}

/** 本轮实付：只累加有真实归集的题（costUsd 缺席不补 0），没有一题有数就返回 null。 */
export function actualCostUsd(report) {
  const costs = (report.results ?? []).map((r) => r.costUsd).filter((c) => typeof c === 'number');
  return costs.length ? costs.reduce((sum, c) => sum + c, 0) : null;
}

const PASS = new Set(['passed']);

/** 退步题：上一轮 passed、本轮不是 passed（含 not_run / infra_excluded——先点名再由人判是不是环境）。 */
export function regressedCases(previous, current) {
  if (!previous) return [];
  const before = new Map((previous.results ?? []).map((r) => [r.testId, r.status]));
  return (current.results ?? [])
    .filter((r) => PASS.has(before.get(r.testId)) && !PASS.has(r.status))
    .map((r) => `${r.testId}（${r.status}）`)
    .sort();
}

/**
 * 五行摘要（通过率 / Δ / 退步题 / 实付 / 被测 model）；有模型漂移时第一行点名。
 * exitCode 2 = 未跑满或静默退化 mock（FAKECLOSED），摘要要把这个放在最前面，别让人读到假通过率。
 */
export function buildCoreSummary({ current, previous, exitCode, reportPath }) {
  const lines = [];
  const drift = detectModelDrift(previous, current);
  if (drift) lines.push(`⚠ ${drift}`);
  if (exitCode === 2) lines.push('⚠ 本轮 exit 2：未跑满或没调真模型，以下数字不可用于对比、禁钉基线');
  const rate = capabilityPassRate(current);
  // 题数不同（如施工期 5 题冒烟 vs 周跑 50 题）通过率不可比，与 BaselineManager 的 planMismatch 同口径。
  const comparable = Boolean(previous) && previous.total === current.total;
  const delta = comparable ? (rate - capabilityPassRate(previous)) * 100 : null;
  const regressed = regressedCases(previous, current);
  const cost = actualCostUsd(current);
  lines.push(`通过率：${(rate * 100).toFixed(1)}%（${current.passed ?? 0}/${current.total ?? 0}，exit ${exitCode}）`);
  lines.push(`Δ：${delta === null ? (previous ? `上一轮题数不同（${previous.total} vs ${current.total}），不可比` : '无上一轮可比') : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`}`);
  lines.push(`退步题：${regressed.length ? regressed.join('、') : previous ? '无' : '无上一轮可比'}`);
  lines.push(`实付：${cost === null ? '无真实归集' : `$${cost.toFixed(4)}`}`);
  lines.push(`被测 model：${reportIdentity(current).subject}（裁判 ${reportIdentity(current).judge}）`);
  if (reportPath) lines.push(`报告：${reportPath}`);
  return lines.join('\n');
}
