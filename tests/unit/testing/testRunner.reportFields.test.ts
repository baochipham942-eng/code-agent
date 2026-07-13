import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestEvent, TestRunSummary, TestRunnerConfig } from '../../../src/host/testing/types';

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

async function createRunner(
  suiteYaml: string,
  configOverrides: Partial<TestRunnerConfig> = {},
): Promise<{ runner: TestRunner; agent: AgentInterface; events: TestEvent[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-report-fields-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml);
  const agent = makeAgent();
  const events: TestEvent[] = [];

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
    ...configOverrides,
  }, agent);

  runner.addEventListener((event) => {
    events.push(event);
  });

  return { runner, agent, events };
}

async function runSuite(
  suiteYaml: string,
  configOverrides: Partial<TestRunnerConfig> = {},
): Promise<TestRunSummary> {
  const { runner } = await createRunner(suiteYaml, configOverrides);
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

  it('rejects parallel maxParallel greater than 1 before any cases execute', async () => {
    const { runner, agent, events } = await createRunner([
      'name: serial-only',
      'cases:',
      '  - id: should-not-run',
      '    type: task',
      '    description: should not run',
      '    prompt: do not execute',
      '    expect:',
      '      response_contains: [response]',
      '',
    ].join('\n'), {
      parallel: true,
      maxParallel: 3,
    });

    await expect(runner.runAll()).rejects.toThrow(
      /serial-only: runner shares a single agent instance and working directory/i,
    );
    expect(agent.sendMessage).not.toHaveBeenCalled();
    expect(agent.reset).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'case_start')).toBe(false);
    expect(events.some((event) => event.type === 'case_end')).toBe(false);
  });

  it('allows parallel true when maxParallel is 1', async () => {
    const { runner, agent, events } = await createRunner([
      'name: serial-fallback',
      'cases:',
      '  - id: runs-serially',
      '    type: task',
      '    description: runs with maxParallel one',
      '    prompt: execute normally',
      '    expect:',
      '      response_contains: [response]',
      '',
    ].join('\n'), {
      parallel: true,
      maxParallel: 1,
    });

    const summary = await runner.runAll();

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(agent.sendMessage).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'case_start')).toBe(true);
    expect(events.some((event) => event.type === 'case_end')).toBe(true);
  });
});
