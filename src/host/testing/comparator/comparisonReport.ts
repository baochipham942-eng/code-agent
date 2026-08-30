// Comparison Report - Generate markdown and console reports from ComparisonResult
import chalk from 'chalk';
import type { ComparisonResult, CaseComparison } from '../types';
import type { EvalRunStamp } from '../../../shared/contract/evaluation';
import { formatDuration } from '../../../shared/utils/format';
import { getRunStampReportRows } from '../runStampReport';
import { describeSignTest, SIGN_TEST_ALPHA } from './signTest';
import { failureCodeLabel, loadProjectFailureCodebook } from '../failureCodes';
import type { HardGateItem, ShipGateState, ShipGateVerdict } from './shipGate';

type ComparisonRunStampContext = {
  gitCommit: string;
  baseline: EvalRunStamp;
  candidate: EvalRunStamp;
};

function formatSkillActivations(activations: Record<string, number>): string {
  const entries = Object.entries(activations).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? entries.map(([name, count]) => `${name}:${count}`).join(', ') : '0';
}

const SHIP_GATE_STATE_TEXT: Record<ShipGateState, string> = {
  candidate_better: '实验组更好 · 可上线',
  non_inferior: '非劣（Δ=3pp）· 可上线',
  candidate_worse: '实验组更差 · 不能上线',
  insufficient: '样本不足 · 不能上线（这不是势均力敌，是数据还不够）',
};

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}pp`;
}

function hardGateCount(item: HardGateItem): string {
  return item.status === 'not_measured' ? '未测量' : String(item.count ?? 0);
}

function hardGateMark(item: HardGateItem): string {
  if (item.status === 'pass') return '✅ pass';
  if (item.status === 'fail') return '❌ fail';
  return '⚠ not_measured';
}

function hardGateFinal(verdict: ShipGateVerdict): string {
  const failed = verdict.hardGate.items.filter((item) => item.status === 'fail');
  if (failed.length > 0) return `❌ ${failed.map((item) => item.key).join(',')}`;
  const unmeasured = verdict.hardGate.items.filter((item) => item.status === 'not_measured');
  if (unmeasured.length > 0) return `⚠ 未测量：${unmeasured.map((item) => item.key).join(',')}`;
  return '✅ ALL PASSED';
}

function shipGateHeadline(result: ComparisonResult): string | null {
  const gate = result.summary.shipGate;
  if (!gate) return null;
  return `结论：${SHIP_GATE_STATE_TEXT[gate.state]}`
    + ` · Δ=${gate.delta}pp · N_min=${gate.nMin} · decisive ${gate.decisivePairs}`
    + ` · p=${gate.pValue.toFixed(4)} · 通过率差 ${formatRate(gate.passRateDiff)}`
    + ` · 置信下界 ${formatRate(gate.ciLowerBound)}`
    + ` · 口径 k=${gate.calibre.k}`
    + ` / aggregationRuleVersion=${gate.calibre.aggregationRuleVersion}`
    + ` / promptVersion=${gate.calibre.promptVersion} · 实验 id(${result.runId})`;
}

/**
 * Generate a Markdown report from a ComparisonResult.
 */
export function generateComparisonMarkdown(
  result: ComparisonResult,
  runStamps?: ComparisonRunStampContext,
): string {
  const { baseline, candidate, summary, cases } = result;
  const lines: string[] = [];

  lines.push(`# A/B Comparison Report`);
  lines.push('');
  const headline = shipGateHeadline(result);
  if (headline && summary.shipGate) {
    lines.push(`> ${headline}`);
    lines.push('');
    lines.push('| 项 | 计数 | 门 |');
    lines.push('|---|---:|---|');
    for (const item of summary.shipGate.hardGate.items) {
      lines.push(`| ${item.key} | ${hardGateCount(item)} | ${hardGateMark(item)} |`);
    }
    lines.push(`| **SHIP GATE** |  | **${hardGateFinal(summary.shipGate)}** |`);
    lines.push('');
  }
  lines.push(`**Run ID:** ${result.runId}`);
  lines.push(`**Date:** ${new Date(result.timestamp).toISOString()}`);
  lines.push(`**Duration:** ${formatDuration(result.duration)}`);
  lines.push('');

  // Configurations
  lines.push(`## Configurations`);
  lines.push('');
  lines.push(`| | Baseline | Candidate |`);
  lines.push(`|---|---|---|`);
  lines.push(`| **Name** | ${baseline.name} | ${candidate.name} |`);
  lines.push(`| **Model** | ${baseline.model ?? '-'} | ${candidate.model ?? '-'} |`);
  lines.push(`| **Provider** | ${baseline.provider ?? '-'} | ${candidate.provider ?? '-'} |`);
  lines.push(`| **Temperature** | ${baseline.temperature ?? '-'} | ${candidate.temperature ?? '-'} |`);
  if (runStamps) {
    lines.push(`| 代码版本 | ${runStamps.gitCommit} | ${runStamps.gitCommit} |`);
    const baselineRows = getRunStampReportRows(runStamps.baseline);
    const candidateRows = new Map(getRunStampReportRows(runStamps.candidate));
    for (const [label, value] of baselineRows) {
      lines.push(`| ${label} | ${value} | ${candidateRows.get(label) ?? '未知'} |`);
    }
  }
  lines.push('');

  // Summary
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| **断言胜方** | **${summary.winner}** |`);
  lines.push(`| Total Cases | ${summary.totalCases} |`);
  lines.push(`| Baseline Wins | ${summary.baselineWins} |`);
  lines.push(`| Candidate Wins | ${summary.candidateWins} |`);
  lines.push(`| Ties | ${summary.ties} |`);
  lines.push(`| Baseline 参考分（启发式/评审） | ${summary.baselineAvgScore.toFixed(2)} |`);
  lines.push(`| Candidate 参考分（启发式/评审） | ${summary.candidateAvgScore.toFixed(2)} |`);
  lines.push(`| Confidence | ${(summary.confidence * 100).toFixed(0)}% |`);
  if (summary.excludedPairs) {
    lines.push(`| 排除 Pair（未计入胜负） | ${summary.excludedPairs} |`);
  }
  if (summary.skillNotActivatedPairs) {
    lines.push(`| 分出胜负的题 | ${summary.totalCases} |`);
    lines.push(`| 实验组 skill 未出场，不计入 | ${summary.skillNotActivatedPairs} |`);
  }
  lines.push(`| Baseline skill 触发次数 | ${formatSkillActivations(summary.baselineSkillActivations)} |`);
  lines.push(`| Candidate skill 触发次数 | ${formatSkillActivations(summary.candidateSkillActivations)} |`);
  {
    const valid = cases.filter((c) => !c.excludedReason && c.assertionCount > 0);
    if (valid.length > 0) {
      const armRate = (role: 'baseline' | 'candidate') => {
        const sum = valid.reduce(
          (acc, c) => acc + (c.assignment.A === role ? c.passRateA : c.passRateB),
          0,
        );
        return sum / valid.length;
      };
      lines.push(`| Baseline 断言条通过率 | ${(armRate('baseline') * 100).toFixed(1)}% (n=${valid.length}) |`);
      lines.push(`| Candidate 断言条通过率 | ${(armRate('candidate') * 100).toFixed(1)}% (n=${valid.length}) |`);
    }
  }
  lines.push('');

  lines.push('## 技术详情');
  lines.push('');
  if (summary.pValue !== undefined) {
    lines.push(`- Sign test: ${describeSignTest(summary.baselineWins, summary.candidateWins, summary.pValue)}`);
  }
  if (summary.shipGate) {
    lines.push(`- reasons: ${summary.shipGate.reasons.join(', ')}`);
  }
  lines.push('');

  lines.push('## 按层别');
  lines.push('');
  lines.push('| 层别 | Baseline wins | Candidate wins | Ties |');
  lines.push('|---|---:|---:|---:|');
  for (const row of layerRows(cases)) {
    lines.push(`| ${row.layer} | ${row.baselineWins} | ${row.candidateWins} | ${row.ties} |`);
  }
  lines.push('');

  lines.push('## 失败原因分布');
  lines.push('');
  lines.push(...generateArmFailureDistribution(result));
  lines.push('');

  // 排除的 pair（WP1-3b）：没跑成 ≠ 势均力敌，单列不进胜负
  const excluded = cases.filter((c) => c.excludedReason);
  if (excluded.length > 0) {
    lines.push(`## 排除的 Pair（未计入胜负）`);
    lines.push('');
    for (const c of excluded) {
      const icon = c.excludedReason === 'skill_not_activated' ? '🫥' : '🔌';
      lines.push(
        `- ${icon} **${c.testId}**: ${c.excludedReason}; `
        + `skill 触发次数 A ${formatSkillActivations(c.skillActivationsA)} / B ${formatSkillActivations(c.skillActivationsB)}`,
      );
    }
    lines.push('');
  }

  // Per-case results
  lines.push(`## Per-Case Results`);
  lines.push('');
  lines.push(`| Test | Layer | A (role) | B (role) | Assertions A | Assertions B | Skill A | Skill B | Assertion Winner | 参考 · 启发式/评审 | Duration A | Duration B |`);
  lines.push(`|---|---|---|---|---:|---:|---|---|---|---|---|---|`);

  for (const c of cases.filter((x) => !x.excludedReason)) {
    lines.push(
      `| ${c.testId} | ${c.layer ?? '其他题目'} | ${c.assignment.A} | ${c.assignment.B} | ${(c.passRateA * 100).toFixed(1)}% | ${(c.passRateB * 100).toFixed(1)}% | ${formatSkillActivations(c.skillActivationsA)} | ${formatSkillActivations(c.skillActivationsB)} | ${c.assertionWinner} | ${c.referenceWinner} (${c.referenceKind}) | ${formatDuration(c.durationA)} | ${formatDuration(c.durationB)} |`,
    );
  }
  lines.push('');

  // Detailed reasoning
  lines.push(`## Detailed Reasoning`);
  lines.push('');
  for (const c of cases) {
    lines.push(`### ${c.testId}: ${c.description}`);
    lines.push('');
    lines.push(`- **断言胜方:** ${c.assertionWinner}（A ${(c.passRateA * 100).toFixed(1)}% / B ${(c.passRateB * 100).toFixed(1)}%，${c.assertionCount} 条）`);
    lines.push(`- **参考 · ${c.referenceKind === 'llm_judge' ? '评审' : '启发式'}:** ${c.referenceWinner}`);
    lines.push(`- **skill 触发次数:** A ${formatSkillActivations(c.skillActivationsA)} / B ${formatSkillActivations(c.skillActivationsB)}`);
    lines.push(`- **参考分 A (${c.assignment.A}):** Content=${c.scoreA.content.total.toFixed(2)}, Structure=${c.scoreA.structure.total.toFixed(2)}, Combined=${c.scoreA.combined.toFixed(2)}`);
    lines.push(`- **参考分 B (${c.assignment.B}):** Content=${c.scoreB.content.total.toFixed(2)}, Structure=${c.scoreB.structure.total.toFixed(2)}, Combined=${c.scoreB.combined.toFixed(2)}`);
    lines.push(`- **参考说明:** ${c.reasoning}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate colored console output from a ComparisonResult.
 */
export function generateComparisonConsole(result: ComparisonResult): string {
  const { baseline, candidate, summary, cases } = result;
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold.underline('A/B Comparison Report'));
  lines.push('');

  const headline = shipGateHeadline(result);
  if (headline && summary.shipGate) {
    lines.push(chalk.bold(headline));
    for (const item of summary.shipGate.hardGate.items) {
      lines.push(`  ${item.key}: ${hardGateCount(item)} · ${hardGateMark(item)}`);
    }
    lines.push(chalk.bold(`  SHIP GATE: ${hardGateFinal(summary.shipGate)}`));
    lines.push('');
  }

  // Config info
  lines.push(chalk.dim(`Run: ${result.runId}`));
  lines.push(chalk.dim(`Duration: ${formatDuration(result.duration)}`));
  lines.push('');
  lines.push(`  Baseline:  ${chalk.cyan(baseline.name)}${baseline.model ? chalk.dim(` (${baseline.model})`) : ''}`);
  lines.push(`  Candidate: ${chalk.magenta(candidate.name)}${candidate.model ? chalk.dim(` (${candidate.model})`) : ''}`);
  lines.push('');

  // Summary
  const winnerColor = summary.winner === 'baseline' ? chalk.cyan : summary.winner === 'candidate' ? chalk.magenta : chalk.yellow;
  lines.push(chalk.bold('Summary'));
  lines.push(`  Winner: ${winnerColor.bold(summary.winner.toUpperCase())}`);
  lines.push(`  Reference score: ${chalk.cyan(summary.baselineAvgScore.toFixed(2))} vs ${chalk.magenta(summary.candidateAvgScore.toFixed(2))}`);
  lines.push(`  Wins:   ${chalk.cyan(String(summary.baselineWins))} - ${chalk.magenta(String(summary.candidateWins))} - ${chalk.yellow(String(summary.ties))} ties`);
  lines.push(`  Skill activations: baseline ${formatSkillActivations(summary.baselineSkillActivations)} / candidate ${formatSkillActivations(summary.candidateSkillActivations)}`);
  if (summary.skillNotActivatedPairs) {
    lines.push(chalk.yellow(`  分出胜负的题: ${summary.totalCases}`));
    lines.push(chalk.yellow(`  实验组有 ${summary.skillNotActivatedPairs} 题 skill 未出场，不计入`));
  }
  lines.push(`  Confidence: ${(summary.confidence * 100).toFixed(0)}%`);
  lines.push('');

  lines.push(chalk.bold('技术详情'));
  if (summary.pValue !== undefined) {
    const sig = summary.pValue <= SIGN_TEST_ALPHA;
    const text = describeSignTest(summary.baselineWins, summary.candidateWins, summary.pValue);
    lines.push(`  Sign test: ${sig ? chalk.green(text) : chalk.yellow(text)}`);
  }
  if (summary.shipGate) lines.push(`  reasons: ${summary.shipGate.reasons.join(', ')}`);
  lines.push('');

  lines.push(chalk.bold('按层别'));
  for (const row of layerRows(cases)) {
    lines.push(`  ${row.layer}: ${chalk.cyan(String(row.baselineWins))}-${chalk.magenta(String(row.candidateWins))}-${chalk.yellow(String(row.ties))} ties`);
  }
  lines.push('');

  // 排除的 pair（WP1-3b）
  const excluded = cases.filter((c) => c.excludedReason);
  if (excluded.length > 0) {
    lines.push(chalk.yellow.bold(`排除的 Pair（未计入胜负）: ${excluded.length}`));
    for (const c of excluded) {
      const icon = c.excludedReason === 'skill_not_activated' ? '🫥' : '🔌';
      lines.push(chalk.yellow(
        `  ${icon} ${c.testId}: ${c.excludedReason}; `
        + `skill A ${formatSkillActivations(c.skillActivationsA)} / B ${formatSkillActivations(c.skillActivationsB)}`,
      ));
    }
    lines.push('');
  }

  // Per-case table
  lines.push(chalk.bold('Per-Case Results'));
  lines.push('');

  for (const c of cases.filter((x) => !x.excludedReason)) {
    const icon = getWinnerIcon(c);
    const winnerLabel = c.realWinner === 'baseline' ? chalk.cyan(c.realWinner) : c.realWinner === 'candidate' ? chalk.magenta(c.realWinner) : chalk.yellow(c.realWinner);

    lines.push(`  ${icon} ${chalk.bold(c.testId)}`);
    lines.push(`    ${chalk.dim(c.description)}`);

    const scoreALabel = c.assignment.A === 'baseline' ? chalk.cyan : chalk.magenta;
    const scoreBLabel = c.assignment.B === 'baseline' ? chalk.cyan : chalk.magenta;

    lines.push(
      `    A(${c.assignment.A}): ${scoreALabel(`${(c.passRateA * 100).toFixed(1)}%`)}  ` +
      `B(${c.assignment.B}): ${scoreBLabel(`${(c.passRateB * 100).toFixed(1)}%`)}  ` +
      `Assertion winner: ${winnerLabel}`,
    );
    lines.push(`    Skill activations: A ${formatSkillActivations(c.skillActivationsA)} / B ${formatSkillActivations(c.skillActivationsB)}`);
    lines.push(`    ${chalk.dim(`参考 · ${c.referenceKind === 'llm_judge' ? '评审' : '启发式'}: ${c.referenceWinner}; ${c.reasoning}`)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function layerRows(cases: CaseComparison[]): Array<{
  layer: string;
  baselineWins: number;
  candidateWins: number;
  ties: number;
}> {
  const grouped = new Map<string, CaseComparison[]>();
  for (const comparison of cases.filter((item) => !item.excludedReason)) {
    const layer = comparison.layer ?? '其他题目';
    grouped.set(layer, [...(grouped.get(layer) ?? []), comparison]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([layer, rows]) => ({
      layer,
      baselineWins: rows.filter((row) => row.realWinner === 'baseline').length,
      candidateWins: rows.filter((row) => row.realWinner === 'candidate').length,
      ties: rows.filter((row) => row.realWinner === 'tie').length,
    }));
}

function getWinnerIcon(c: CaseComparison): string {
  if (c.realWinner === 'baseline') return chalk.cyan('◆');
  if (c.realWinner === 'candidate') return chalk.magenta('◆');
  return chalk.yellow('◇');
}

function comparisonFailureLabel(code: string): string {
  try {
    const codebook = loadProjectFailureCodebook();
    return failureCodeLabel(codebook, code);
  } catch {
    return code === 'unknown' ? '未归类' : code;
  }
}

function comparisonDispositionLabel(disposition: string): string {
  if (disposition === 'retryable') return '可以重试';
  if (disposition === 'not_in_denominator') return '不计入通过率';
  if (disposition === 'needs_human') return '需要人工确认';
  if (disposition.startsWith('known_issue:')) return `已知问题 ${disposition.slice('known_issue:'.length)}`;
  return disposition;
}

function failureForRole(c: CaseComparison, role: 'baseline' | 'candidate') {
  return c.assignment.A === role ? c.failureA : c.failureB;
}

function countArmFailures(
  cases: CaseComparison[],
  role: 'baseline' | 'candidate',
): { codes: Record<string, number>; dispositions: Record<string, number> } {
  const codes: Record<string, number> = { unknown: 0 };
  const dispositions: Record<string, number> = {};
  for (const c of cases) {
    const failure = failureForRole(c, role);
    if (!failure) continue;
    codes[failure.code] = (codes[failure.code] ?? 0) + 1;
    for (const disposition of failure.dispositions) {
      dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
    }
  }
  return { codes, dispositions };
}

function generateArmFailureDistribution(result: ComparisonResult): string[] {
  const baseline = countArmFailures(result.cases, 'baseline');
  const candidate = countArmFailures(result.cases, 'candidate');
  const codes = [...new Set([...Object.keys(baseline.codes), ...Object.keys(candidate.codes)])]
    .sort((left, right) => (
      (baseline.codes[right] ?? 0) + (candidate.codes[right] ?? 0)
      - (baseline.codes[left] ?? 0) - (candidate.codes[left] ?? 0)
      || left.localeCompare(right)
    ));
  const dispositions = [...new Set([
    ...Object.keys(baseline.dispositions),
    ...Object.keys(candidate.dispositions),
  ])].sort();
  return [
    '| 失败原因 | 对照组 | 实验组 |',
    '|----------|--------|--------|',
    ...codes.map((code) => (
      `| ${comparisonFailureLabel(code)} <span style="color:#888"><code>${code}</code></span> | ${baseline.codes[code] ?? 0} | ${candidate.codes[code] ?? 0} |`
    )),
    '',
    '### 处置标签',
    '',
    '| 处置 | 对照组 | 实验组 |',
    '|------|--------|--------|',
    ...(dispositions.length > 0
      ? dispositions.map((disposition) => (
          `| ${comparisonDispositionLabel(disposition)} | ${baseline.dispositions[disposition] ?? 0} | ${candidate.dispositions[disposition] ?? 0} |`
        ))
      : ['| 暂无 | 0 | 0 |']),
  ];
}
