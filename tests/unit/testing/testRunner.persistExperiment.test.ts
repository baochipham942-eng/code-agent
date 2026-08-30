import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestRunnerConfig } from '../../../src/host/testing/types';

const persistTestRun = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@internal-evaluation/host/evaluation/experimentAdapter', () => ({
  ExperimentAdapter: class {
    persistTestRun = persistTestRun;
  },
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ database: 'test' }),
}));

import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';

const roots: string[] = [];

async function makeConfig(persistExperiment: boolean): Promise<TestRunnerConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-persist-switch-'));
  roots.push(root);
  const caseDir = path.join(root, 'cases');
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(path.join(caseDir, 'suite.yaml'), [
    'name: persist-switch',
    'cases:',
    '  - id: case-1',
    '    type: task',
    '    prompt: answer',
    '    expect:',
    '      response_contains: [ok]',
    '',
  ].join('\n'));
  return {
    testCaseDir: caseDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 1_000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
    persistExperiment,
  };
}

function agent(): AgentInterface {
  return {
    sendMessage: vi.fn(async () => ({
      responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'test', model: 'mock-model', provider: 'mock' }),
  };
}

afterEach(async () => {
  persistTestRun.mockClear();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('TestRunner experiment persistence switch', () => {
  it('does not write experiments when an event-stream child is configured stateless', async () => {
    const runner = new TestRunner(await makeConfig(false), agent());

    await expect(runner.runAll()).resolves.toMatchObject({ total: 1, passed: 1 });
    expect(persistTestRun).not.toHaveBeenCalled();
  });

  it('preserves direct CLI persistence by default when explicitly enabled', async () => {
    const runner = new TestRunner(await makeConfig(true), agent());

    await runner.runAll();
    expect(persistTestRun).toHaveBeenCalledTimes(1);
  });

  it('allocates and cleans a fresh execution context for every trial', async () => {
    const config = await makeConfig(false);
    config.trialsPerCase = 2;
    const baseAgent = agent();
    const isolatedAgents: AgentInterface[] = [];
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const runner = new TestRunner(config, baseAgent, undefined, undefined, async () => {
      const isolatedAgent = agent();
      const cleanup = vi.fn(async () => undefined);
      isolatedAgents.push(isolatedAgent);
      cleanups.push(cleanup);
      return {
        agent: isolatedAgent,
        workingDirectory: config.workingDirectory,
        cleanup,
      };
    });

    await expect(runner.runAll()).resolves.toMatchObject({ total: 1, passed: 1 });
    expect(isolatedAgents).toHaveLength(2);
    expect(baseAgent.sendMessage).not.toHaveBeenCalled();
    expect(isolatedAgents.every((item) => vi.mocked(item.sendMessage).mock.calls.length === 1)).toBe(true);
    expect(cleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
  });
});
