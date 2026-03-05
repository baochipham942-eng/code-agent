#!/usr/bin/env npx tsx
// ============================================================================
// eval-ci.ts — CLI entry point for Eval-Driven Development
// ============================================================================
//
// Usage:
//   npx tsx scripts/eval-ci.ts                    # auto-detect scope
//   npx tsx scripts/eval-ci.ts --scope smoke      # smoke tests only
//   npx tsx scripts/eval-ci.ts --scope full       # full suite
//   npx tsx scripts/eval-ci.ts --promote          # promote to baseline
//   npx tsx scripts/eval-ci.ts --baseline-info    # show baseline
//   npx tsx scripts/eval-ci.ts --trend            # show trend

import chalk from 'chalk';
import { execSync } from 'child_process';
import { ChangeDetector } from '../src/main/testing/ci/changeDetector';
import { BaselineManager } from '../src/main/testing/ci/baselineManager';
import { TrendTracker } from '../src/main/testing/ci/trendTracker';
import { generateDeltaConsole } from '../src/main/testing/ci/deltaReporter';
import {
  TestRunner,
  createDefaultConfig,
  MockAgentAdapter,
  loadAllTestSuites,
  generateConsoleReport,
  saveReport,
} from '../src/main/testing/index';
import type { TestRunSummary, TrendDataPoint } from '../src/main/testing/types';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let scope: 'smoke' | 'full' | undefined;
  let promote = false;
  let baselineInfo = false;
  let trend = false;
  let base: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scope' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'smoke' || val === 'full') {
        scope = val;
      } else {
        console.error(chalk.red(`Invalid scope: ${val}. Use 'smoke' or 'full'.`));
        process.exit(1);
      }
    } else if (arg === '--promote') {
      promote = true;
    } else if (arg === '--baseline-info') {
      baselineInfo = true;
    } else if (arg === '--trend') {
      trend = true;
    } else if (arg === '--base' && i + 1 < args.length) {
      base = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return { scope, promote, baselineInfo, trend, base };
}

function printUsage() {
  console.log(`
${chalk.bold('eval-ci')} — Eval-Driven Development CLI

${chalk.dim('Usage:')}
  npx tsx scripts/eval-ci.ts                    Auto-detect scope from git diff
  npx tsx scripts/eval-ci.ts --scope smoke      Smoke tests only
  npx tsx scripts/eval-ci.ts --scope full       Full eval suite
  npx tsx scripts/eval-ci.ts --promote          Promote current results to baseline
  npx tsx scripts/eval-ci.ts --baseline-info    Show current baseline
  npx tsx scripts/eval-ci.ts --trend            Show trend chart
  npx tsx scripts/eval-ci.ts --base <ref>       Git ref to diff against (default: HEAD)
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showBaselineInfo(manager: BaselineManager) {
  const baseline = await manager.load();
  if (!baseline) {
    console.log(chalk.yellow('  No baseline found. Run evals and use --promote to create one.'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  Eval Baseline'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log(`  Updated:     ${new Date(baseline.updatedAt).toISOString()}`);
  console.log(`  Commit:      ${baseline.updatedBy}`);
  console.log(`  Pass Rate:   ${(baseline.globalMetrics.passRate * 100).toFixed(1)}%`);
  console.log(`  Avg Score:   ${(baseline.globalMetrics.averageScore * 100).toFixed(1)}%`);
  console.log(`  Total Cases: ${baseline.globalMetrics.totalCases}`);
  console.log('');
  console.log(chalk.dim('  Thresholds:'));
  console.log(`    Min Pass Rate:    ${(baseline.thresholds.minPassRate * 100).toFixed(0)}%`);
  console.log(`    Max Score Drop:   ${(baseline.thresholds.maxScoreDrop * 100).toFixed(0)}%`);
  console.log(`    Max New Failures: ${baseline.thresholds.maxNewFailures}`);
  console.log('');

  const caseCount = Object.keys(baseline.caseResults).length;
  if (caseCount > 0) {
    const statuses: Record<string, number> = {};
    for (const c of Object.values(baseline.caseResults)) {
      statuses[c.status] = (statuses[c.status] || 0) + 1;
    }
    console.log(chalk.dim('  Case breakdown:'));
    for (const [status, count] of Object.entries(statuses)) {
      console.log(`    ${status}: ${count}`);
    }
    console.log('');
  }
}

async function showTrend(tracker: TrendTracker) {
  const recent = await tracker.getRecent(20);
  if (recent.length === 0) {
    console.log(chalk.yellow('  No trend data yet. Run evals to start tracking.'));
    return;
  }
  console.log('');
  console.log(tracker.generateAsciiChart(recent));
  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCommitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function runEvals(workingDir: string, _scope: 'smoke' | 'full'): Promise<TestRunSummary> {
  const config = createDefaultConfig(workingDir, {
    verbose: false,
  });

  const mockAgent = new MockAgentAdapter();
  mockAgent.setMockResponse('列出当前目录', {
    responses: ['当前目录包含以下文件：package.json, src/, ...'],
    toolExecutions: [
      {
        tool: 'bash',
        input: { command: 'ls' },
        output: 'package.json\nsrc\nnode_modules\n',
        success: true,
        duration: 50,
        timestamp: Date.now(),
      },
    ],
  });

  const runner = new TestRunner(config, mockAgent);

  runner.addEventListener((event) => {
    switch (event.type) {
      case 'case_end': {
        const icon =
          event.result.status === 'passed'
            ? '✅'
            : event.result.status === 'failed'
            ? '❌'
            : '⏭️';
        console.log(
          `  ${icon} ${event.result.testId.padEnd(30)} ${event.result.duration}ms`
        );
        break;
      }
      case 'suite_end':
        console.log(generateConsoleReport(event.summary));
        break;
    }
  });

  const summary = await runner.runAll();

  const savedFiles = await saveReport(summary, config.resultsDir);
  console.log(chalk.dim(`  Reports saved to: ${savedFiles[0]}`));

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { scope, promote, baselineInfo, trend, base } = parseArgs(process.argv);

  const workingDir = process.cwd();
  const manager = new BaselineManager(workingDir);
  const tracker = new TrendTracker(workingDir);

  // --baseline-info
  if (baselineInfo) {
    await showBaselineInfo(manager);
    return;
  }

  // --trend
  if (trend) {
    await showTrend(tracker);
    return;
  }

  // --promote: run evals then promote results to baseline
  if (promote) {
    console.log(chalk.bold('  Running evals before promoting to baseline...'));
    console.log('');
    const summary = await runEvals(workingDir, 'full');
    const commitSha = getCommitSha();
    await manager.promote(summary, commitSha);
    console.log(chalk.green(`  Baseline promoted (commit: ${commitSha.slice(0, 7)})`));
    console.log(`  Pass rate: ${(summary.total > 0 ? (summary.passed / summary.total) * 100 : 0).toFixed(1)}%`);
    console.log(`  Avg score: ${(summary.averageScore * 100).toFixed(1)}%`);
    console.log('');
    return;
  }

  // Change detection
  const detector = new ChangeDetector();
  const detection = await detector.detectTriggeringChanges(base);

  const effectiveScope = scope ?? detection.scope;

  console.log('');
  console.log(chalk.bold('  Eval-Driven Development'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log(`  Scope:        ${chalk.cyan(effectiveScope)}`);
  console.log(`  Should run:   ${detection.shouldRunEval ? chalk.green('yes') : chalk.dim('no')}`);
  console.log(`  Trigger:      ${detection.triggerReason}`);

  if (detection.changedFiles.length > 0) {
    console.log(`  Changed files: ${detection.changedFiles.length}`);
    for (const f of detection.changedFiles.slice(0, 10)) {
      console.log(chalk.dim(`    • ${f}`));
    }
    if (detection.changedFiles.length > 10) {
      console.log(chalk.dim(`    ... and ${detection.changedFiles.length - 10} more`));
    }
  }
  console.log('');

  if (!detection.shouldRunEval && !scope) {
    console.log(chalk.dim('  No eval-triggering changes detected. Skipping.'));
    console.log(chalk.dim('  Use --scope smoke|full to force a run.'));
    return;
  }

  // Run evals
  console.log(chalk.cyan(`  Running ${effectiveScope} eval suite...`));
  console.log('');
  const summary = await runEvals(workingDir, effectiveScope);

  // Compare to baseline
  const delta = await manager.compare(summary);
  console.log(generateDeltaConsole(summary, delta));

  // Track trend
  const commitSha = getCommitSha();
  const passRate = summary.total > 0 ? summary.passed / summary.total : 0;
  const trendPoint: TrendDataPoint = {
    timestamp: Date.now(),
    commitSha,
    scope: effectiveScope,
    passRate,
    averageScore: summary.averageScore,
    totalCases: summary.total,
    duration: summary.duration,
    newFailures: delta.newFailures.length,
    newPasses: delta.newPasses.length,
  };
  await tracker.append(trendPoint);
  console.log(chalk.dim(`  Trend data recorded (commit: ${commitSha.slice(0, 7)})`));
  console.log('');

  // Exit with non-zero if regression detected
  if (delta.isRegression) {
    console.log(chalk.red.bold('  Exiting with code 1 due to regression.'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red('eval-ci failed:'), err);
  process.exit(1);
});
