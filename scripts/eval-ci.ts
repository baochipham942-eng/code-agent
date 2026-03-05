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
import { ChangeDetector } from '../src/main/testing/ci/changeDetector';
import { BaselineManager } from '../src/main/testing/ci/baselineManager';
import { TrendTracker } from '../src/main/testing/ci/trendTracker';

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

  // --promote (placeholder — requires a TestRunSummary from an actual eval run)
  if (promote) {
    console.log(chalk.yellow('  Promote requires a completed eval run.'));
    console.log(chalk.dim('  Integration with TestRunner is Phase 3.'));
    console.log(chalk.dim('  Once integrated: run evals first, then --promote to update baseline.'));
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

  // Placeholder for actual eval execution (Phase 3)
  console.log(chalk.yellow(`  Would run ${effectiveScope} eval suite...`));
  console.log(chalk.dim('  TestRunner integration is Phase 3.'));
  console.log('');

  // Placeholder for compare-to-baseline step
  console.log(chalk.dim('  After eval completes:'));
  console.log(chalk.dim('    1. Compare results against baseline'));
  console.log(chalk.dim('    2. Generate delta report'));
  console.log(chalk.dim('    3. Append to trend data'));
  console.log(chalk.dim('    4. Exit with non-zero code if regression detected'));
  console.log('');
}

main().catch((err) => {
  console.error(chalk.red('eval-ci failed:'), err);
  process.exit(1);
});
