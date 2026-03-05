// ============================================================================
// Delta Reporter — Generates comparison reports between eval runs
// ============================================================================

import chalk from 'chalk';
import type { TestRunSummary, BaselineDelta } from '../types';

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function generateDeltaMarkdown(
  summary: TestRunSummary,
  delta: BaselineDelta,
  trendChart?: string,
): string {
  const lines: string[] = [];
  const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

  lines.push('## Eval Delta Report');
  lines.push('');

  if (delta.isFirstRun) {
    lines.push('> **First run** — no baseline to compare against.');
    lines.push('');
  }

  // Metrics table
  lines.push('### Metrics');
  lines.push('');
  lines.push('| Metric | Baseline | Current | Delta |');
  lines.push('| ------ | -------: | ------: | ----: |');

  if (delta.isFirstRun) {
    lines.push(`| Pass Rate | — | ${fmtPct(passRate)} | — |`);
    lines.push(`| Avg Score | — | ${fmtPct(summary.averageScore)} | — |`);
    lines.push(`| Total Cases | — | ${summary.total} | — |`);
  } else {
    const basePassRate = passRate - delta.passRateDelta;
    const baseScore = summary.averageScore - delta.scoreDelta;
    lines.push(
      `| Pass Rate | ${fmtPct(basePassRate)} | ${fmtPct(passRate)} | ${fmtDelta(delta.passRateDelta)} |`,
    );
    lines.push(
      `| Avg Score | ${fmtPct(baseScore)} | ${fmtPct(summary.averageScore)} | ${fmtDelta(delta.scoreDelta)} |`,
    );
    lines.push(`| Total Cases | — | ${summary.total} | — |`);
  }
  lines.push('');

  // Regression warning
  if (delta.isRegression) {
    lines.push('### Regression Detected');
    lines.push('');
    for (const detail of delta.regressionDetails) {
      lines.push(`- ${detail}`);
    }
    lines.push('');
  }

  // New failures
  if (delta.newFailures.length > 0) {
    lines.push('### New Failures');
    lines.push('');
    for (const f of delta.newFailures) {
      const reason = f.reason ? ` — ${f.reason}` : '';
      lines.push(`- **${f.testId}** (was: ${f.previousStatus})${reason}`);
    }
    lines.push('');
  }

  // New passes
  if (delta.newPasses.length > 0) {
    lines.push('### New Passes');
    lines.push('');
    for (const p of delta.newPasses) {
      lines.push(`- ${p.testId}`);
    }
    lines.push('');
  }

  // Trend chart
  if (trendChart) {
    lines.push('### Trend');
    lines.push('');
    lines.push('```');
    lines.push(trendChart);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Console report (colored)
// ---------------------------------------------------------------------------

export function generateDeltaConsole(
  summary: TestRunSummary,
  delta: BaselineDelta,
): string {
  const lines: string[] = [];
  const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

  lines.push('');
  lines.push(chalk.bold('  Eval Delta Report'));
  lines.push(chalk.dim('  ' + '─'.repeat(50)));

  if (delta.isFirstRun) {
    lines.push(chalk.yellow('  First run — no baseline to compare'));
    lines.push('');
    lines.push(`  Pass Rate:  ${fmtPctColored(passRate)}`);
    lines.push(`  Avg Score:  ${fmtPctColored(summary.averageScore)}`);
    lines.push(`  Total:      ${summary.total}`);
  } else {
    const basePassRate = passRate - delta.passRateDelta;
    const baseScore = summary.averageScore - delta.scoreDelta;

    lines.push(`  Pass Rate:  ${fmtPct(basePassRate)} → ${fmtPctColored(passRate)}  ${fmtDeltaColored(delta.passRateDelta)}`);
    lines.push(`  Avg Score:  ${fmtPct(baseScore)} → ${fmtPctColored(summary.averageScore)}  ${fmtDeltaColored(delta.scoreDelta)}`);
    lines.push(`  Total:      ${summary.total}`);
  }

  lines.push('');

  // Regression
  if (delta.isRegression) {
    lines.push(chalk.red.bold('  REGRESSION DETECTED'));
    for (const detail of delta.regressionDetails) {
      lines.push(chalk.red(`    • ${detail}`));
    }
    lines.push('');
  }

  // New failures
  if (delta.newFailures.length > 0) {
    lines.push(chalk.red(`  New Failures (${delta.newFailures.length}):`));
    for (const f of delta.newFailures) {
      const reason = f.reason ? chalk.dim(` — ${f.reason}`) : '';
      lines.push(`    ${chalk.red('✗')} ${f.testId} (was: ${f.previousStatus})${reason}`);
    }
    lines.push('');
  }

  // New passes
  if (delta.newPasses.length > 0) {
    lines.push(chalk.green(`  New Passes (${delta.newPasses.length}):`));
    for (const p of delta.newPasses) {
      lines.push(`    ${chalk.green('✓')} ${p.testId}`);
    }
    lines.push('');
  }

  if (!delta.isRegression && delta.newFailures.length === 0) {
    lines.push(chalk.green('  All clear — no regressions detected'));
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtDelta(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function fmtPctColored(value: number): string {
  const text = fmtPct(value);
  if (value >= 0.9) return chalk.green(text);
  if (value >= 0.7) return chalk.yellow(text);
  return chalk.red(text);
}

function fmtDeltaColored(value: number): string {
  const text = fmtDelta(value);
  if (value > 0) return chalk.green(text);
  if (value < 0) return chalk.red(text);
  return chalk.dim(text);
}
