// ============================================================================
// Auto Test Hook - SessionStart hook for automatic testing
// ============================================================================

import path from 'path';
import fs from 'fs/promises';
import type { SessionContext } from '../hooks/events';
import type { TestRunSummary } from './types';
import { TestRunner, createDefaultConfig } from './testRunner';
import { MockAgentAdapter, StandaloneAgentAdapter } from './agentAdapter';
import { generateMarkdownReport, generateConsoleReport, saveReport } from './reportGenerator';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('AutoTestHook');

/**
 * Check if auto-test mode is enabled
 */
export function isAutoTestEnabled(): boolean {
  return process.env.AUTO_TEST === 'true' ||
         process.env.CODE_AGENT_AUTO_TEST === 'true';
}

/**
 * Get auto-test configuration from environment
 */
export function getAutoTestConfig(): {
  enabled: boolean;
  testCaseDir?: string;
  resultsDir?: string;
  filterTags?: string[];
  filterIds?: string[];
  stopOnFailure: boolean;
  verbose: boolean;
  generation: string;
  provider: string;
  model: string;
} {
  return {
    enabled: isAutoTestEnabled(),
    testCaseDir: process.env.AUTO_TEST_CASES_DIR,
    resultsDir: process.env.AUTO_TEST_RESULTS_DIR,
    filterTags: process.env.AUTO_TEST_TAGS?.split(',').map(t => t.trim()),
    filterIds: process.env.AUTO_TEST_IDS?.split(',').map(t => t.trim()),
    stopOnFailure: process.env.AUTO_TEST_STOP_ON_FAILURE === 'true',
    verbose: process.env.AUTO_TEST_VERBOSE === 'true',
    generation: process.env.AUTO_TEST_GENERATION || 'gen4',
    provider: process.env.AUTO_TEST_PROVIDER || 'deepseek',
    model: process.env.AUTO_TEST_MODEL || 'deepseek-chat',
  };
}

/**
 * Run auto-tests on session start
 */
export async function runAutoTests(
  context: SessionContext
): Promise<TestRunSummary | null> {
  const config = getAutoTestConfig();

  if (!config.enabled) {
    return null;
  }

  logger.info('Auto-test mode enabled, starting tests...');

  const workingDirectory = context.workingDirectory;

  // Create test runner configuration
  const runnerConfig = createDefaultConfig(workingDirectory, {
    testCaseDir: config.testCaseDir || path.join(workingDirectory, '.claude', 'test-cases'),
    resultsDir: config.resultsDir || path.join(workingDirectory, '.claude', 'test-results'),
    filterTags: config.filterTags,
    filterIds: config.filterIds,
    stopOnFailure: config.stopOnFailure,
    verbose: config.verbose,
  });

  // Check if test cases directory exists
  try {
    await fs.access(runnerConfig.testCaseDir);
  } catch {
    logger.warn('Test cases directory not found, skipping auto-tests', {
      testCaseDir: runnerConfig.testCaseDir,
    });
    return null;
  }

  // Create agent adapter
  const agent = new StandaloneAgentAdapter({
    workingDirectory,
    generation: config.generation,
    modelConfig: {
      provider: config.provider,
      model: config.model,
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY,
    },
  });

  // Create and run test runner
  const runner = new TestRunner(runnerConfig, agent);

  // Add console logging for real-time updates
  if (config.verbose) {
    runner.addEventListener((event) => {
      switch (event.type) {
        case 'suite_start':
          console.log(`\n🧪 Starting test suite: ${event.suite} (${event.totalCases} cases)`);
          break;
        case 'case_start':
          console.log(`  ▶️ Running: ${event.testId}`);
          break;
        case 'case_end':
          const icon = event.result.status === 'passed' ? '✅' :
                       event.result.status === 'failed' ? '❌' : '⏭️';
          console.log(`  ${icon} ${event.result.testId} (${event.result.duration}ms)`);
          if (event.result.failureReason) {
            console.log(`     └─ ${event.result.failureReason}`);
          }
          break;
        case 'suite_end':
          console.log(generateConsoleReport(event.summary));
          break;
        case 'error':
          console.error(`  ❗ Error: ${event.error}`);
          break;
      }
    });
  }

  try {
    const summary = await runner.runAll();

    // Save reports
    const savedFiles = await saveReport(summary, runnerConfig.resultsDir, ['markdown', 'json']);
    logger.info('Test reports saved', { files: savedFiles });

    // Print summary to console
    console.log(generateConsoleReport(summary));

    // Also log the path to the full report
    console.log(`\n📄 Full report: ${path.join(runnerConfig.resultsDir, 'latest-report.md')}`);

    return summary;

  } catch (error: any) {
    logger.error('Auto-test failed', { error: error.message });
    console.error('❌ Auto-test failed:', error.message);
    return null;
  }
}

/**
 * Create the SessionStart hook configuration for auto-testing
 */
export function createAutoTestHookConfig(): {
  type: 'builtin';
  name: string;
  handler: (context: SessionContext) => Promise<{ action: 'continue'; message?: string }>;
} {
  return {
    type: 'builtin',
    name: 'auto-test',
    handler: async (context: SessionContext) => {
      const summary = await runAutoTests(context);

      if (summary) {
        const passRate = summary.total > 0
          ? ((summary.passed / (summary.total - summary.skipped)) * 100).toFixed(1)
          : '0';

        return {
          action: 'continue' as const,
          message: `Auto-test completed: ${summary.passed}/${summary.total} passed (${passRate}%)`,
        };
      }

      return { action: 'continue' as const };
    },
  };
}
