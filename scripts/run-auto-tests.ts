#!/usr/bin/env npx tsx
// ============================================================================
// CLI Script to Run Auto Tests
// ============================================================================
//
// Usage:
//   npx tsx scripts/run-auto-tests.ts [options]
//
// Options:
//   --tags <tag1,tag2>      Filter by tags
//   --ids <id1,id2>         Filter by test IDs
//   --stop-on-failure       Stop on first failure
//   --verbose               Verbose output
//   --generation <gen>      Generation to test (default: from constants)
//   --provider <provider>   Model provider (default: from constants)
//   --model <model>         Model name (default: from constants)
//   --runs <N>              Run each case N times (statistical mode, default: 1)
//   --real                  Use real Agent (calls LLM API + executes tools)
//   --help                  Show help
//
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_GENERATION } from '../src/shared/constants';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Parse command line arguments
function parseArgs(): {
  tags?: string[];
  ids?: string[];
  stopOnFailure: boolean;
  verbose: boolean;
  generation: string;
  provider: string;
  model: string;
  runs: number;
  real: boolean;
  help: boolean;
} {
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
    real: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tags':
        result.tags = args[++i]?.split(',').map((t) => t.trim());
        break;
      case '--ids':
        result.ids = args[++i]?.split(',').map((t) => t.trim());
        break;
      case '--stop-on-failure':
        result.stopOnFailure = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--generation':
        result.generation = args[++i];
        break;
      case '--provider':
        result.provider = args[++i];
        break;
      case '--model':
        result.model = args[++i];
        break;
      case '--runs':
        result.runs = parseInt(args[++i], 10) || 1;
        break;
      case '--real':
        result.real = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
Code Agent Auto Test Runner

Usage:
  npx tsx scripts/run-auto-tests.ts [options]

Options:
  --tags <tag1,tag2>      Filter tests by tags
  --ids <id1,id2>         Filter tests by IDs
  --stop-on-failure       Stop on first test failure
  --verbose, -v           Show verbose output
  --generation <gen>      Generation to test (default: ${DEFAULT_GENERATION})
  --provider <provider>   Model provider (default: ${DEFAULT_PROVIDER})
  --model <model>         Model name (default: ${DEFAULT_MODEL})
  --runs <N>              Run each case N times (statistical mode, default: 1)
  --real                  Use real Agent (calls LLM API + executes tools)
  --help, -h              Show this help

Test Case Tags:
  - tools      Basic tool execution tests
  - tasks      Task completion tests
  - conversation Understanding tests
  - errors     Error handling tests
  - basic      Basic functionality
  - integration Integration tests
  - security   Security tests

Environment Variables:
  MOONSHOT_API_KEY        API key for Moonshot (Kimi)
  DEEPSEEK_API_KEY        API key for DeepSeek
  ZHIPU_API_KEY           API key for Zhipu
  OPENAI_API_KEY          API key for OpenAI (fallback)

Examples:
  # Run all tests (mock mode)
  npx tsx scripts/run-auto-tests.ts

  # Run with real agent
  npx tsx scripts/run-auto-tests.ts --real --ids bash-ls,read-file-exists -v

  # Run only tool tests
  npx tsx scripts/run-auto-tests.ts --tags tools

  # Use a different provider
  npx tsx scripts/run-auto-tests.ts --real --provider deepseek --model deepseek-chat

  # Statistical mode: run each case 3 times
  npx tsx scripts/run-auto-tests.ts --runs 3 -v
`);
}

/** Provider → environment variable name candidates (tried in order) */
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

  // Load .env content once
  let envContent: string | null = null;
  try {
    const envPath = path.join(projectRoot, '.env');
    envContent = await fs.readFile(envPath, 'utf-8');
  } catch {
    // .env doesn't exist
  }

  // Try each candidate
  for (const envVarName of candidates) {
    // Environment variable
    if (process.env[envVarName]) {
      return process.env[envVarName];
    }
    // .env file
    if (envContent) {
      const match = envContent.match(new RegExp(`${envVarName}=["']?([^"'\\s\\n]+)["']?`));
      if (match) {
        return match[1].trim();
      }
    }
  }

  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('           Code Agent Auto Test Runner                 ');
  console.log('═══════════════════════════════════════════════════════\n');

  // Load API key
  const apiKey = await loadApiKey(args.provider);
  if (!apiKey) {
    const candidates = PROVIDER_KEY_CANDIDATES[args.provider] || [`${args.provider.toUpperCase()}_API_KEY`];
    console.error(`❌ No API key found. Set ${candidates.join(' or ')} environment variable or add it to .env`);
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Mode:       ${args.real ? '🤖 Real Agent (LLM API)' : '🧩 Mock Agent'}`);
  console.log(`  Generation: ${args.generation}`);
  console.log(`  Provider:   ${args.provider}`);
  console.log(`  Model:      ${args.model}`);
  console.log(`  Runs:       ${args.runs}${args.runs > 1 ? ' (statistical mode)' : ''}`);
  console.log(`  Tags:       ${args.tags?.join(', ') || '(all)'}`);
  console.log(`  IDs:        ${args.ids?.join(', ') || '(all)'}`);
  console.log('');

  // --real mode: build CJS bundle via esbuild, then spawn it
  // (AgentLoop's import chain uses __dirname and electron, which require CJS bundling)
  if (args.real) {
    const builtFile = path.join(projectRoot, 'dist/test-runner.cjs');

    // Build if missing or older than source
    let needsBuild = true;
    try {
      const stat = await fs.stat(builtFile);
      // Rebuild if older than 1 hour (good enough for dev)
      needsBuild = Date.now() - stat.mtimeMs > 3600_000;
    } catch { /* file doesn't exist */ }

    if (needsBuild) {
      console.log('📦 Building test runner...');
      try {
        execSync('npm run build:test-runner', { cwd: projectRoot, stdio: 'pipe' });
        console.log('📦 Build complete\n');
      } catch (err: any) {
        console.error('❌ Build failed:', err.stderr?.toString() || err.message);
        process.exit(1);
      }
    }

    // Forward all args except --real to the built runner
    const forwardArgs = process.argv.slice(2).filter(a => a !== '--real');
    const child = spawn('node', [builtFile, ...forwardArgs], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }

  // Mock mode: run directly via tsx (no CJS bundling needed)
  try {
    const testing = await import('../src/main/testing/index.js');

    const workingDirectory = projectRoot;
    const config = testing.createDefaultConfig(workingDirectory, {
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

    const mockAgent = new testing.MockAgentAdapter();
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

    console.log('🧩 Using mock Agent (no API calls)\n');

    if (args.runs > 1) {
      // Statistical mode: run each case N times
      console.log(`📊 Statistical mode: running each case ${args.runs} times\n`);
      const statsRunner = new testing.StatisticalRunner(config, mockAgent, { runs: args.runs });
      const statsSummary = await statsRunner.runAll();

      // Print statistical report
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

      // Per-case detail
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
      // Single-run mode (original behavior)
      const runner = new testing.TestRunner(config, mockAgent);

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
            const icon =
              event.result.status === 'passed'
                ? '✅'
                : event.result.status === 'failed'
                ? '❌'
                : '⏭️';
            console.log(
              `  ${icon} ${event.result.testId.padEnd(30)} ${event.result.duration}ms`
            );
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


  } catch (error: any) {
    console.error('\n❌ Test runner failed:', error.message);
    if (args.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
