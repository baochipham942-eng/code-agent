import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function makeAgent(): AgentInterface {
  return {
    sendMessage: vi.fn(async (prompt: string) => ({
      responses: [`response to ${prompt}`],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
  };
}

async function runSuite(suiteYaml: string): Promise<TestRunSummary> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-report-fields-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml);

  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, makeAgent());

  return runner.runAll();
}

describe('testRunner report fields', () => {
  it('copies prompt and follow_up_prompts into TestResult for report drill-down', async () => {
    const summary = await runSuite([
      'name: report-fields',
      'cases:',
      '  - id: with-prompts',
      '    type: task',
      '    description: preserves prompts',
      '    prompt: first prompt',
      '    follow_up_prompts:',
      '      - second prompt',
      '      - third prompt',
      '    expect:',
      '      response_contains: [response]',
      '',
    ].join('\n'));

    expect(summary.results[0].prompt).toBe('first prompt');
    expect(summary.results[0].followUpPrompts).toEqual(['second prompt', 'third prompt']);
  });

  it('also copies prompt fields when a case is skipped by unmet dependencies', async () => {
    const summary = await runSuite([
      'name: skipped-report-fields',
      'cases:',
      '  - id: blocked',
      '    type: task',
      '    description: dependency skipped',
      '    prompt: blocked prompt',
      '    follow_up_prompts:',
      '      - blocked follow up',
      '    depends_on: [missing-case]',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));

    expect(summary.results[0].status).toBe('skipped');
    expect(summary.results[0].prompt).toBe('blocked prompt');
    expect(summary.results[0].followUpPrompts).toEqual(['blocked follow up']);
  });
});
