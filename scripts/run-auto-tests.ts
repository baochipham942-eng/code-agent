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
//   --generation <gen>      Generation to test (default: gen4)
//   --provider <provider>   Model provider (default: deepseek)
//   --model <model>         Model name (default: deepseek-chat)
//   --help                  Show help
//
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

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
  help: boolean;
} {
  const args = process.argv.slice(2);
  const result = {
    tags: undefined as string[] | undefined,
    ids: undefined as string[] | undefined,
    stopOnFailure: false,
    verbose: false,
    generation: 'gen4',
    provider: 'deepseek',
    model: 'deepseek-chat',
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
  --generation <gen>      Generation to test (default: gen4)
  --provider <provider>   Model provider (default: deepseek)
  --model <model>         Model name (default: deepseek-chat)
  --help, -h              Show this help

Test Case Tags:
  - tools      Basic tool execution tests
  - tasks      Task completion tests
  - conversation Understanding tests
  - errors     Error handling tests
  - basic      Basic functionality
  - integration Integration tests

Environment Variables:
  DEEPSEEK_API_KEY        API key for DeepSeek
  OPENAI_API_KEY          API key for OpenAI

Examples:
  # Run all tests
  npx tsx scripts/run-auto-tests.ts

  # Run only tool tests
  npx tsx scripts/run-auto-tests.ts --tags tools

  # Run specific tests
  npx tsx scripts/run-auto-tests.ts --ids bash-ls,read-file-exists

  # Verbose mode with stop on failure
  npx tsx scripts/run-auto-tests.ts -v --stop-on-failure
`);
}

async function loadApiKey(): Promise<string | undefined> {
  // Try environment variable
  if (process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }

  // Try .env file
  try {
    const envPath = path.join(projectRoot, '.env');
    const content = await fs.readFile(envPath, 'utf-8');
    const match = content.match(/DEEPSEEK_API_KEY=["']?([^"'\s\n]+)["']?/);
    if (match) {
      return match[1].trim();
    }
  } catch {
    // .env doesn't exist
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
  const apiKey = await loadApiKey();
  if (!apiKey) {
    console.error('❌ No API key found. Set DEEPSEEK_API_KEY environment variable.');
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Generation: ${args.generation}`);
  console.log(`  Provider:   ${args.provider}`);
  console.log(`  Model:      ${args.model}`);
  console.log(`  Tags:       ${args.tags?.join(', ') || '(all)'}`);
  console.log(`  IDs:        ${args.ids?.join(', ') || '(all)'}`);
  console.log('');

  // Set environment variables for the test runner
  process.env.AUTO_TEST = 'true';
  process.env.AUTO_TEST_VERBOSE = args.verbose ? 'true' : 'false';
  process.env.AUTO_TEST_STOP_ON_FAILURE = args.stopOnFailure ? 'true' : 'false';
  process.env.AUTO_TEST_GENERATION = args.generation;
  process.env.AUTO_TEST_PROVIDER = args.provider;
  process.env.AUTO_TEST_MODEL = args.model;

  if (args.tags) {
    process.env.AUTO_TEST_TAGS = args.tags.join(',');
  }
  if (args.ids) {
    process.env.AUTO_TEST_IDS = args.ids.join(',');
  }

  try {
    // Dynamic import of testing module
    const testing = await import('../src/main/testing/index.js');

    const workingDirectory = projectRoot;
    const config = testing.createDefaultConfig(workingDirectory, {
      filterTags: args.tags,
      filterIds: args.ids,
      stopOnFailure: args.stopOnFailure,
      verbose: args.verbose,
    });

    // Check test cases exist
    try {
      await fs.access(config.testCaseDir);
    } catch {
      console.error(`❌ Test cases directory not found: ${config.testCaseDir}`);
      process.exit(1);
    }

    // Create mock agent for dry run / verification
    const mockAgent = new testing.MockAgentAdapter();

    // Set up some mock responses for testing the framework itself
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

    const runner = new testing.TestRunner(config, mockAgent);

    // Add event listener for progress
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
        case 'case_end':
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
        case 'suite_end':
          console.log(testing.generateConsoleReport(event.summary));
          break;
      }
    });

    // Run tests
    const summary = await runner.runAll();

    // Save reports
    const savedFiles = await testing.saveReport(summary, config.resultsDir);
    console.log(`\n📄 Reports saved:`);
    for (const file of savedFiles) {
      console.log(`   ${file}`);
    }

    // Exit with appropriate code
    process.exit(summary.failed > 0 ? 1 : 0);

  } catch (error: any) {
    console.error('\n❌ Test runner failed:', error.message);
    if (args.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
