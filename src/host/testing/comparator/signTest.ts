// 配对 sign test（精确二项，双尾）— --compare 的统计显著性。
// 只看 decisive pair（baseline 赢 / candidate 赢），tie 与 excluded pair
// 不进 n。p = min(1, 2 × P(X ≥ max(wins, losses)))，X ~ Binomial(n, 0.5)。
// 用对数域累加避免大 n 时 C(n,k) 溢出。

/** 显著性阈值（双尾） */
export const SIGN_TEST_ALPHA = 0.05;

export function signTestPValue(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.max(wins, losses);

  // log C(n, i) 递推：C(n,0)=1；C(n,i) = C(n,i-1) * (n-i+1)/i
  let logC = 0;
  let logTailSum = -Infinity; // log(Σ C(n,i)), i∈[k, n]
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) {
      logTailSum = logTailSum === -Infinity
        ? logC
        : logTailSum + Math.log1p(Math.exp(logC - logTailSum));
    }
  }

  const logP = logTailSum + n * Math.log(0.5);
  return Math.min(1, 2 * Math.exp(logP));
}

/** 人话解读：报告用 */
export function describeSignTest(wins: number, losses: number, pValue: number): string {
  const n = wins + losses;
  if (n === 0) return '无 decisive pair，无法检验';
  if (pValue <= SIGN_TEST_ALPHA) {
    return `p=${pValue.toFixed(4)} ≤ ${SIGN_TEST_ALPHA}，差异显著（decisive ${n} 对）`;
  }
  return `p=${pValue.toFixed(4)} > ${SIGN_TEST_ALPHA}，样本不足以判定差异（decisive ${n} 对）`;
}
