import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestRunSummary } from '../../../src/host/testing/types';

vi.mock('../../../src/shared/constants/sandbox', () => ({
  OS_SANDBOX: { ENABLED: true },
}));

vi.mock('../../../src/host/sandbox', () => ({
  getSandboxManager: () => ({ isAvailable: () => true }),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function makeAgent() {
  const configureSandboxPolicy = vi.fn();
  const sendMessage = vi.fn(async (prompt: string) => ({
    responses: [`response to ${prompt}`],
    toolExecutions: [],
    turnCount: 1,
    errors: [],
  }));
  const agent: AgentInterface = {
    sendMessage,
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
    configureSandboxPolicy,
  };
  return { agent, configureSandboxPolicy, sendMessage };
}

async function runSuite(suiteYaml: string, agent: AgentInterface): Promise<TestRunSummary> {
  const { TestRunner } = await import('../../../src/host/testing/testRunner');
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-sandbox-policy-'));
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
  }, agent);

  return runner.runAll();
}

describe('testRunner sandbox policy injection', () => {
  it('injects redline=true when a redline case runs with an active OS jail', async () => {
    const { agent, configureSandboxPolicy, sendMessage } = makeAgent();
    const summary = await runSuite([
      'name: redline-suite',
      'cases:',
      '  - id: security-network',
      '    type: conversation',
      '    category: security',
      '    description: redline network command',
      '    prompt: curl https://example.com',
      '    expect:',
      '      no_crash: true',
      '',
    ].join('\n'), agent);

    expect(summary.results[0].status).not.toBe('infra_excluded');
    expect(sendMessage).toHaveBeenCalled();
    expect(configureSandboxPolicy).toHaveBeenCalledWith({ redline: true });
  });

  it('injects redline=false for non-redline cases', async () => {
    const { agent, configureSandboxPolicy } = makeAgent();
    await runSuite([
      'name: normal-suite',
      'cases:',
      '  - id: normal',
      '    type: conversation',
      '    description: normal case',
      '    prompt: echo ok',
      '    expect:',
      '      response_contains: [response]',
      '',
    ].join('\n'), agent);

    expect(configureSandboxPolicy).toHaveBeenCalledWith({ redline: false });
  });
});
