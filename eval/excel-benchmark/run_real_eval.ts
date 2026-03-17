#!/usr/bin/env npx tsx
// ============================================================================
// Excel Benchmark Real Eval - 只跑 18-excel-benchmark-tests.yaml
// ============================================================================
// Usage: npx tsx eval/excel-benchmark/run_real_eval.ts
// ============================================================================

import chalk from 'chalk';
import {
  TestRunner,
  createDefaultConfig,
  StandaloneAgentAdapter,
  loadAllTestSuites,
  generateConsoleReport,
  saveReport,
} from '../../src/main/testing/index';
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from '../../src/shared/constants';

async function main() {
  const workingDir = process.cwd();

  // Use filterTags in config to only run Excel benchmark cases
  const config = createDefaultConfig(workingDir, {
    verbose: true,
    defaultTimeout: 180000, // 3 min per case
    filterTags: ['benchmark', 'excel'],
  });

  const resolvedProvider = process.env.AUTO_TEST_PROVIDER || DEFAULT_PROVIDER;
  const resolvedModel = process.env.AUTO_TEST_MODEL || DEFAULT_MODEL;

  console.log(chalk.bold('\n  Excel AI Benchmark — Real Mode'));
  console.log(chalk.dim('  ' + '═'.repeat(50)));
  console.log(chalk.cyan(`  Provider: ${resolvedProvider}`));
  console.log(chalk.cyan(`  Model:    ${resolvedModel}`));
  console.log('');

  // Verify Excel suite exists
  const allSuites = await loadAllTestSuites(config.testCaseDir);
  const excelSuite = allSuites.find(s => s.name.includes('Excel AI Benchmark'));
  if (!excelSuite) {
    console.error(chalk.red('  Excel benchmark suite not found!'));
    console.log('  Available suites:', allSuites.map(s => s.name).join(', '));
    process.exit(1);
  }
  console.log(chalk.green(`  Suite: ${excelSuite.name}`));
  console.log(chalk.green(`  Cases: ${excelSuite.cases.length}\n`));

  const agent = new StandaloneAgentAdapter({
    workingDirectory: workingDir,
    generation: 'gen8',
    modelConfig: {
      provider: resolvedProvider,
      model: resolvedModel,
      apiKey: process.env.AUTO_TEST_API_KEY,
    },
  });

  const runner = new TestRunner(config, agent);

  // Event listener
  runner.addEventListener((event) => {
    switch (event.type) {
      case 'case_start':
        console.log(chalk.dim(`\n  ▶ Starting: ${event.testId}`));
        break;
      case 'case_end': {
        const icon =
          event.result.status === 'passed' ? '✅' :
          event.result.status === 'failed' ? '❌' : '🟡';
        const score = event.result.score !== undefined
          ? ` (${Math.round(event.result.score * 100)}%)`
          : '';
        console.log(
          `  ${icon} ${event.result.testId.padEnd(30)} ${event.result.duration}ms${score}`
        );
        if (event.result.status === 'failed' && event.result.failureReason) {
          console.log(chalk.red(`     Reason: ${event.result.failureReason}`));
        }
        break;
      }
      case 'suite_end':
        console.log('\n' + generateConsoleReport(event.summary));
        break;
    }
  });

  // Run only Excel benchmark cases (filtered by tags in config)
  const summary = await runner.runAll();

  // Save report
  const savedFiles = await saveReport(summary, config.resultsDir);
  console.log(chalk.dim(`\n  Reports saved to: ${savedFiles[0]}`));

  // Print final summary
  const passed = summary.results.filter(r => r.status === 'passed').length;
  const failed = summary.results.filter(r => r.status === 'failed').length;
  const partial = summary.results.filter(r => r.status === 'partial').length;
  const total = summary.results.length;

  console.log('\n' + chalk.bold('  ═══ Excel Benchmark Results ═══'));
  console.log(`  Total:   ${total}`);
  console.log(chalk.green(`  Passed:  ${passed}`));
  console.log(chalk.yellow(`  Partial: ${partial}`));
  console.log(chalk.red(`  Failed:  ${failed}`));
  console.log(`  Score:   ${(summary.averageScore * 100).toFixed(1)}%`);
  console.log('');
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});
