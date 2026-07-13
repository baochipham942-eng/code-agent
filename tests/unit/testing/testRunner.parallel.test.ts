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

function makeSerialAgent(): AgentInterface {
  return {
    sendMessage: vi.fn(async (prompt: string) => ({
      responses: [prompt === 'alpha prompt' ? 'alpha ok' : 'beta only'],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'serial-agent', model: 'mock-model', provider: 'mock' }),
  };
}

function normalizeSerialSummary(summary: TestRunSummary) {
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    partial: summary.partial,
    infraExcluded: summary.infraExcluded,
    averageScore: summary.averageScore,
    results: summary.results.map((result) => ({
      testId: result.testId,
      description: result.description,
      prompt: result.prompt,
      status: result.status,
      responses: result.responses,
      errors: result.errors,
      turnCount: result.turnCount,
      score: result.score,
      scoreAuthority: result.scoreAuthority,
      failureReason: result.failureReason,
      failureDetails: result.failureDetails,
    })),
    environment: {
      model: summary.environment.model,
      provider: summary.environment.provider,
      providerVariantArm: summary.environment.providerVariantArm,
    },
    performance: {
      totalToolCalls: summary.performance.totalToolCalls,
      totalTurns: summary.performance.totalTurns,
    },
  };
}

async function createSerialRunner(): Promise<TestRunner> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-runner-parallel-serial-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), [
    'name: serial-characterization',
    'cases:',
    '  - id: alpha',
    '    type: task',
    '    description: alpha passes',
    '    prompt: alpha prompt',
    '    expect:',
    '      response_contains: [alpha]',
    '  - id: beta',
    '    type: task',
    '    description: beta is partial',
    '    prompt: beta prompt',
    '    depends_on: [alpha]',
    '    expect:',
    '      response_contains: [beta, missing]',
    '',
  ].join('\n'));

  return new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 1000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, makeSerialAgent());
}

describe('TestRunner parallel execution', () => {
  it('characterizes serial summary order and result fields', async () => {
    const runner = await createSerialRunner();

    const summary = normalizeSerialSummary(await runner.runAll());

    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      skipped: 0,
      partial: 1,
      infraExcluded: 0,
      averageScore: 0.75,
      results: [
        {
          testId: 'alpha',
          description: 'alpha passes',
          prompt: 'alpha prompt',
          status: 'passed',
          responses: ['alpha ok'],
          errors: [],
          turnCount: 1,
          score: 1,
          scoreAuthority: 'deterministic_assertion',
          failureReason: undefined,
          failureDetails: undefined,
        },
        {
          testId: 'beta',
          description: 'beta is partial',
          prompt: 'beta prompt',
          status: 'partial',
          responses: ['beta only'],
          errors: [],
          turnCount: 1,
          score: 0.5,
          scoreAuthority: 'deterministic_assertion',
          failureReason: 'Expected response to contain "missing"',
          failureDetails: {
            expected: ['missing'],
            actual: ['beta only'],
            assertion: 'response_contains',
          },
        },
      ],
      environment: {
        model: 'mock-model',
        provider: 'mock',
        providerVariantArm: 'variant-on',
      },
      performance: {
        totalToolCalls: 0,
        totalTurns: 2,
      },
    });
  });
});
