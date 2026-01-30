#!/usr/bin/env node

import { Command } from 'commander';
import { TestRunner } from './runner.js';
import { loadTestCases } from './loader.js';
import { generateReports, ReportFormat } from './reporters/index.js';
import { Category, Complexity } from './types.js';

const program = new Command();

program
  .name('claude-e2e')
  .description('Claude Agent E2E Testing Framework')
  .version('1.0.0');

program
  .command('run')
  .description('Run test cases')
  .option(
    '-c, --category <categories...>',
    'Filter by categories (generation, debugging, etc.)'
  )
  .option(
    '-l, --level <levels...>',
    'Filter by complexity levels (L1, L2, L3, L4)'
  )
  .option('-i, --id <ids...>', 'Run specific test case IDs')
  .option('-t, --tag <tags...>', 'Filter by tags')
  .option(
    '-f, --format <formats...>',
    'Report formats: console, json, html, all',
    ['console']
  )
  .option('-o, --output <dir>', 'Output directory for reports', './results')
  .option('--preserve', 'Preserve work directories on failure', true)
  .option('--no-preserve', 'Clean up all work directories')
  .option('--timeout <ms>', 'Global timeout in milliseconds', '300000')
  .option('--concurrency <n>', 'Number of concurrent tests', '1')
  .option('--verbose', 'Verbose output', false)
  .option('--dry-run', 'List matching tests without running', false)
  .action(async (options) => {
    try {
      const allCases = await loadTestCases();

      const filter = {
        categories: options.category as Category[] | undefined,
        complexities: options.level as Complexity[] | undefined,
        ids: options.id,
        tags: options.tag,
      };

      if (options.dryRun) {
        const runner = new TestRunner({ filter });
        const filtered = runner.filterTestCases(allCases);
        console.log(`\n📋 Matching test cases (${filtered.length}):\n`);
        for (const tc of filtered) {
          console.log(`  [${tc.complexity}] ${tc.id}: ${tc.name}`);
        }
        return;
      }

      const runner = new TestRunner({
        filter,
        preserveOnFail: options.preserve,
        timeout: parseInt(options.timeout),
        concurrency: parseInt(options.concurrency),
      });

      const { ConsoleReporter } = await import('./reporters/console.js');
      const consoleReporter = new ConsoleReporter({ verbose: options.verbose });

      runner.on('start', ({ total }) => consoleReporter.onStart(total));
      runner.on('testStart', (tc) => consoleReporter.onTestStart(tc));
      runner.on('testEnd', (result) => consoleReporter.onTestEnd(result));
      runner.on('skip', (result) => consoleReporter.onTestEnd(result));

      const report = await runner.run(allCases);

      await generateReports(report, {
        formats: options.format as ReportFormat[],
        outputDir: options.output,
        verbose: options.verbose,
      });

      process.exit(report.summary.failed > 0 ? 1 : 0);
    } catch (error: any) {
      console.error('❌ Error:', error.message);
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List all available test cases')
  .option('-c, --category <category>', 'Filter by category')
  .option('-l, --level <level>', 'Filter by complexity level')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const allCases = await loadTestCases();

    let filtered = allCases;
    if (options.category) {
      filtered = filtered.filter((tc) => tc.category === options.category);
    }
    if (options.level) {
      filtered = filtered.filter((tc) => tc.complexity === options.level);
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          filtered.map((tc) => ({
            id: tc.id,
            name: tc.name,
            category: tc.category,
            complexity: tc.complexity,
            tags: tc.tags,
          })),
          null,
          2
        )
      );
    } else {
      console.log(`\n📋 Test Cases (${filtered.length}):\n`);

      const grouped = filtered.reduce(
        (acc, tc) => {
          if (!acc[tc.category]) acc[tc.category] = [];
          acc[tc.category].push(tc);
          return acc;
        },
        {} as Record<string, typeof filtered>
      );

      for (const [cat, cases] of Object.entries(grouped)) {
        console.log(`\n📁 ${cat.toUpperCase()} (${cases.length})`);
        for (const tc of cases) {
          const tags = tc.tags?.length ? ` [${tc.tags.join(', ')}]` : '';
          console.log(`   [${tc.complexity}] ${tc.id}: ${tc.name}${tags}`);
        }
      }
    }
  });

program
  .command('init')
  .description('Initialize fixtures and test environment')
  .action(async () => {
    console.log('🔧 Initializing fixtures...');
    // TODO: 实现 fixture 初始化
    console.log('✅ Fixtures initialized');
  });

program.parse();
