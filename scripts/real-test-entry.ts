// ============================================================================
// Real Test Runner Entry - esbuild CJS bundle entry point
// ============================================================================
// This file is bundled by esbuild into CJS format, which provides __dirname
// and allows Module.prototype.require patching to intercept electron imports.
//
// Built by: npm run build:test-runner
// Run by: run-auto-tests.ts --real (auto-builds and spawns)
// ============================================================================

// 0. Set CLI mode flag to skip native modules that segfault outside Electron
process.env.CODE_AGENT_CLI_MODE = 'true';

// 1. Inject electron mock (must be FIRST, before any other imports)
import electronMock from '../src/cli/electron-mock';

const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id: string) {
  if (id === 'electron') {
    return electronMock;
  }
  return originalRequire.apply(this, arguments);
};

// 2. Now safe to import everything
import path from 'path';
import fs from 'fs/promises';
import * as testing from '../src/main/testing/index';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_GENERATION } from '../src/shared/constants';

// ============================================================================

const projectRoot = path.resolve(__dirname, '..');

/** Provider → env var candidates */
const PROVIDER_KEY_CANDIDATES: Record<string, string[]> = {
  moonshot: ['KIMI_K25_API_KEY', 'MOONSHOT_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  zhipu: ['ZHIPU_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  claude: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

async function loadApiKey(provider: string): Promise<string | undefined> {
  const candidates = PROVIDER_KEY_CANDIDATES[provider] || [`${provider.toUpperCase()}_API_KEY`];

  let envContent: string | null = null;
  try {
    envContent = await fs.readFile(path.join(projectRoot, '.env'), 'utf-8');
  } catch { /* no .env */ }

  for (const envVarName of candidates) {
    if (process.env[envVarName]) return process.env[envVarName];
    if (envContent) {
      const match = envContent.match(new RegExp(`${envVarName}=["']?([^"'\\s\\n]+)["']?`));
      if (match) return match[1].trim();
    }
  }
  return undefined;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    tags: undefined as string[] | undefined,
    ids: undefined as string[] | undefined,
    stopOnFailure: false,
    verbose: false,
    generation: DEFAULT_GENERATION,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    runs: 1,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tags': result.tags = args[++i]?.split(',').map(t => t.trim()); break;
      case '--ids': result.ids = args[++i]?.split(',').map(t => t.trim()); break;
      case '--stop-on-failure': result.stopOnFailure = true; break;
      case '--verbose': case '-v': result.verbose = true; break;
      case '--generation': result.generation = args[++i]; break;
      case '--provider': result.provider = args[++i]; break;
      case '--model': result.model = args[++i]; break;
      case '--runs': result.runs = parseInt(args[++i]) || 1; break;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs();

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('        Code Agent Auto Test Runner (Real Mode)        ');
  console.log('═══════════════════════════════════════════════════════\n');

  const apiKey = await loadApiKey(args.provider);
  if (!apiKey) {
    const candidates = PROVIDER_KEY_CANDIDATES[args.provider] || [`${args.provider.toUpperCase()}_API_KEY`];
    console.error(`❌ No API key found. Set ${candidates.join(' or ')} in env or .env`);
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Mode:       🤖 Real Agent`);
  console.log(`  Generation: ${args.generation}`);
  console.log(`  Provider:   ${args.provider}`);
  console.log(`  Model:      ${args.model}`);
  console.log(`  Runs:       ${args.runs}`);
  console.log(`  Tags:       ${args.tags?.join(', ') || '(all)'}`);
  console.log(`  IDs:        ${args.ids?.join(', ') || '(all)'}`);
  console.log('');

  const config = testing.createDefaultConfig(projectRoot, {
    filterTags: args.tags,
    filterIds: args.ids,
    stopOnFailure: args.stopOnFailure,
    verbose: args.verbose,
  });

  try {
    await fs.access(config.testCaseDir);
  } catch {
    console.error(`❌ Test cases directory not found: ${config.testCaseDir}`);
    process.exit(1);
  }

  const agent = new testing.StandaloneAgentAdapter({
    workingDirectory: projectRoot,
    generation: args.generation,
    modelConfig: { provider: args.provider, model: args.model, apiKey },
  });

  if (args.runs > 1) {
    // Statistical mode
    console.log(`📊 Statistical mode: running each case ${args.runs} times\n`);
    const statsRunner = new testing.StatisticalRunner(config, agent, { runs: args.runs });
    const statsSummary = await statsRunner.runAll();

    const agg = statsSummary.aggregate;
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('           Statistical Summary                         ');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Total Cases:     ${agg.totalCases}`);
    console.log(`  Total Runs:      ${agg.totalRuns}`);
    console.log(`  pass@1:          ${(agg.overallPassAt1 * 100).toFixed(1)}%`);
    console.log(`  pass@k:          ${(agg.overallPassAtK * 100).toFixed(1)}%`);
    console.log(`  pass^k:          ${(agg.overallPassCaretK * 100).toFixed(1)}%`);
    console.log(`  Mean Score:      ${(agg.meanScore * 100).toFixed(1)}%`);
    console.log(`  Score Stddev:    ${(agg.scoreStddev * 100).toFixed(1)}%`);
    console.log('');

    if (agg.flakyCases.length > 0) {
      console.log(`  Flaky Cases (${agg.flakyCases.length}):`);
      for (const id of agg.flakyCases) {
        console.log(`    ⚠️  ${id}`);
      }
      console.log('');
    }

    if (agg.stableCases.length > 0) {
      console.log(`  Stable Cases (${agg.stableCases.length}):`);
      for (const id of agg.stableCases) {
        console.log(`    ✅ ${id}`);
      }
      console.log('');
    }

    if (args.verbose) {
      console.log('───────────────────────────────────────────────────────');
      console.log('  Per-Case Detail');
      console.log('───────────────────────────────────────────────────────');
      for (const cr of statsSummary.caseResults) {
        const flakyTag = cr.isFlaky ? ' [FLAKY]' : '';
        console.log(`  ${cr.testId}${flakyTag}`);
        console.log(`    pass@1=${(cr.passAt1 * 100).toFixed(0)}%  pass@k=${(cr.passAtK * 100).toFixed(0)}%  pass^k=${(cr.passCaretK * 100).toFixed(0)}%`);
        console.log(`    score: mean=${(cr.scoreStats.mean * 100).toFixed(0)}% stddev=${(cr.scoreStats.stddev * 100).toFixed(0)}% [${(cr.scoreStats.min * 100).toFixed(0)}%-${(cr.scoreStats.max * 100).toFixed(0)}%]`);
        console.log(`    status: passed=${cr.statusDistribution.passed} failed=${cr.statusDistribution.failed} partial=${cr.statusDistribution.partial} skipped=${cr.statusDistribution.skipped}`);
        console.log(`    avg duration: ${cr.avgDuration.toFixed(0)}ms`);
        console.log('');
      }
    }

    console.log('═══════════════════════════════════════════════════════');
    process.exit(agg.overallPassAt1 < 0.5 ? 1 : 0);

  } else {
    // Single-run mode
    const runner = new testing.TestRunner(config, agent);

    runner.addEventListener((event) => {
      switch (event.type) {
        case 'suite_start':
          console.log(`\n🧪 Starting tests (${event.totalCases} cases)\n`);
          break;
        case 'case_start':
          if (args.verbose) {
            console.log(`  ▶️  ${event.testId}: ${event.description}`);
          }
          break;
        case 'case_end': {
          const icon = event.result.status === 'passed' ? '✅'
            : event.result.status === 'failed' ? '❌' : '⏭️';
          console.log(`  ${icon} ${event.result.testId.padEnd(30)} ${event.result.duration}ms`);
          if (event.result.failureReason && args.verbose) {
            console.log(`     └─ ${event.result.failureReason}`);
          }
          break;
        }
        case 'suite_end':
          console.log(testing.generateConsoleReport(event.summary));
          break;
      }
    });

    const summary = await runner.runAll();

    const savedFiles = await testing.saveReport(summary, config.resultsDir);
    console.log(`\n📄 Reports saved:`);
    for (const file of savedFiles) {
      console.log(`   ${file}`);
    }

    process.exit(summary.failed > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('\n❌ Test runner failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
