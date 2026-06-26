// Comparison Report - Generate markdown and console reports from ComparisonResult
import chalk from 'chalk';
import type { ComparisonResult, CaseComparison } from '../types';
import { formatDuration } from '../../../shared/utils/format';

/**
 * Generate a Markdown report from a ComparisonResult.
 */
export function generateComparisonMarkdown(result: ComparisonResult): string {
  const { baseline, candidate, summary, cases } = result;
  const lines: string[] = [];

  lines.push(`# A/B Comparison Report`);
  lines.push('');
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
  lines.push('');

  // Summary
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| **Winner** | **${summary.winner}** |`);
  lines.push(`| Total Cases | ${summary.totalCases} |`);
  lines.push(`| Baseline Wins | ${summary.baselineWins} |`);
  lines.push(`| Candidate Wins | ${summary.candidateWins} |`);
  lines.push(`| Ties | ${summary.ties} |`);
  lines.push(`| Baseline Avg Score | ${summary.baselineAvgScore.toFixed(2)} |`);
  lines.push(`| Candidate Avg Score | ${summary.candidateAvgScore.toFixed(2)} |`);
  lines.push(`| Confidence | ${(summary.confidence * 100).toFixed(0)}% |`);
  lines.push('');
  lines.push(`> ${summary.verdict}`);
  lines.push('');

  // Per-case results
  lines.push(`## Per-Case Results`);
  lines.push('');
  lines.push(`| Test | A (role) | B (role) | Score A | Score B | Winner | Real Winner | Duration A | Duration B |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);

  for (const c of cases) {
    lines.push(
      `| ${c.testId} | ${c.assignment.A} | ${c.assignment.B} | ${c.scoreA.combined.toFixed(2)} | ${c.scoreB.combined.toFixed(2)} | ${c.winner} | ${c.realWinner} | ${formatDuration(c.durationA)} | ${formatDuration(c.durationB)} |`,
    );
  }
  lines.push('');

  // Detailed reasoning
  lines.push(`## Detailed Reasoning`);
  lines.push('');
  for (const c of cases) {
    lines.push(`### ${c.testId}: ${c.description}`);
    lines.push('');
    lines.push(`- **Winner:** ${c.winner} (${c.realWinner})`);
    lines.push(`- **Score A (${c.assignment.A}):** Content=${c.scoreA.content.total.toFixed(2)}, Structure=${c.scoreA.structure.total.toFixed(2)}, Combined=${c.scoreA.combined.toFixed(2)}`);
    lines.push(`- **Score B (${c.assignment.B}):** Content=${c.scoreB.content.total.toFixed(2)}, Structure=${c.scoreB.structure.total.toFixed(2)}, Combined=${c.scoreB.combined.toFixed(2)}`);
    lines.push(`- **Reasoning:** ${c.reasoning}`);
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
  lines.push(`  Score:  ${chalk.cyan(summary.baselineAvgScore.toFixed(2))} vs ${chalk.magenta(summary.candidateAvgScore.toFixed(2))}`);
  lines.push(`  Wins:   ${chalk.cyan(String(summary.baselineWins))} - ${chalk.magenta(String(summary.candidateWins))} - ${chalk.yellow(String(summary.ties))} ties`);
  lines.push(`  Confidence: ${(summary.confidence * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(chalk.dim(`  ${summary.verdict}`));
  lines.push('');

  // Per-case table
  lines.push(chalk.bold('Per-Case Results'));
  lines.push('');

  for (const c of cases) {
    const icon = getWinnerIcon(c);
    const winnerLabel = c.realWinner === 'baseline' ? chalk.cyan(c.realWinner) : c.realWinner === 'candidate' ? chalk.magenta(c.realWinner) : chalk.yellow(c.realWinner);

    lines.push(`  ${icon} ${chalk.bold(c.testId)}`);
    lines.push(`    ${chalk.dim(c.description)}`);

    const scoreALabel = c.assignment.A === 'baseline' ? chalk.cyan : chalk.magenta;
    const scoreBLabel = c.assignment.B === 'baseline' ? chalk.cyan : chalk.magenta;

    lines.push(
      `    A(${c.assignment.A}): ${scoreALabel(c.scoreA.combined.toFixed(2))}  ` +
      `B(${c.assignment.B}): ${scoreBLabel(c.scoreB.combined.toFixed(2))}  ` +
      `Winner: ${winnerLabel}`,
    );
    lines.push(`    ${chalk.dim(c.reasoning)}`);
    lines.push('');
  }

  return lines.join('\n');
}

function getWinnerIcon(c: CaseComparison): string {
  if (c.realWinner === 'baseline') return chalk.cyan('◆');
  if (c.realWinner === 'candidate') return chalk.magenta('◆');
  return chalk.yellow('◇');
}
