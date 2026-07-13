import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { TestRunSummary } from '../../../src/host/testing/types';

const MOCK_CASE_DELAY_MS = 100;
const PARALLEL_CASE_COUNT = 6;
const MAX_PARALLEL_WORKERS = 3;
const WALL_CLOCK_RATIO_LIMIT = 0.7;

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

async function createSuiteRoot(suiteYaml: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'test-runner-parallel-'));
  const casesDir = path.join(root, 'cases');
  const workDir = path.join(root, 'work');
  await mkdir(casesDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), suiteYaml);
  return { root, casesDir, workDir };
}

function parallelConfig(root: string, casesDir: string, workDir: string) {
  return {
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: workDir,
    defaultTimeout: 2000,
    stopOnFailure: false,
    verbose: false,
    parallel: true,
    maxParallel: MAX_PARALLEL_WORKERS,
    enableEvalCritic: false,
  };
}

function passingAgent(sendMessage: AgentInterface['sendMessage']): AgentInterface {
  return {
    sendMessage,
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'parallel-agent', model: 'mock-model', provider: 'mock' }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it('runs independent cases concurrently within the worker bound', async () => {
    const cases = Array.from({ length: PARALLEL_CASE_COUNT }, (_, index) => [
      `  - id: case-${index}`,
      '    type: task',
      `    description: parallel case ${index}`,
      `    prompt: case-${index}`,
      '    expect:',
      '      response_contains: [ok]',
    ].join('\n'));
    const { root, casesDir, workDir } = await createSuiteRoot([
      'name: bounded-workers',
      'cases:',
      ...cases,
      '',
    ].join('\n'));
    let active = 0;
    let peak = 0;

    const runner = new TestRunner(
      parallelConfig(root, casesDir, workDir),
      makeSerialAgent(),
      () => passingAgent(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(MOCK_CASE_DELAY_MS);
        active -= 1;
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      }),
    );

    const startedAt = Date.now();
    const summary = await runner.runAll();
    const elapsed = Date.now() - startedAt;

    expect(summary.passed).toBe(PARALLEL_CASE_COUNT);
    expect(elapsed).toBeLessThan(PARALLEL_CASE_COUNT * MOCK_CASE_DELAY_MS * WALL_CLOCK_RATIO_LIMIT);
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_WORKERS);
  });

  it('waits for passing dependencies before scheduling dependent cases', async () => {
    const { root, casesDir, workDir } = await createSuiteRoot([
      'name: dependency-order',
      'cases:',
      '  - id: A',
      '    type: task',
      '    prompt: A',
      '    expect:',
      '      response_contains: [ok]',
      '  - id: B',
      '    type: task',
      '    prompt: B',
      '    depends_on: [A]',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));
    const starts = new Map<string, number>();
    const ends = new Map<string, number>();

    const runner = new TestRunner(
      parallelConfig(root, casesDir, workDir),
      makeSerialAgent(),
      () => passingAgent(async (prompt) => {
        starts.set(prompt, Date.now());
        await sleep(MOCK_CASE_DELAY_MS);
        ends.set(prompt, Date.now());
        return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
      }),
    );

    const summary = await runner.runAll();

    expect(summary.results.map((result) => result.status)).toEqual(['passed', 'passed']);
    expect(starts.get('B')).toBeGreaterThanOrEqual(ends.get('A')!);
  });

  it('skips dependent cases when a dependency fails', async () => {
    const { root, casesDir, workDir } = await createSuiteRoot([
      'name: dependency-failure',
      'cases:',
      '  - id: A',
      '    type: task',
      '    prompt: A',
      '    expect:',
      '      response_contains: [pass-token]',
      '  - id: B',
      '    type: task',
      '    prompt: B',
      '    depends_on: [A]',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ].join('\n'));
    const prompts: string[] = [];

    const runner = new TestRunner(
      parallelConfig(root, casesDir, workDir),
      makeSerialAgent(),
      () => passingAgent(async (prompt) => {
        prompts.push(prompt);
        return { responses: ['failed'], toolExecutions: [], turnCount: 1, errors: [] };
      }),
    );

    const summary = await runner.runAll();

    expect(summary.results[0].status).toBe('failed');
    expect(summary.results[1].status).toBe('skipped');
    expect(summary.results[1].failureReason).toMatch(/dependencies not met: A/i);
    expect(prompts).toEqual(['A']);
  });

  it('keeps setup, injected files, agent and assertions in one isolated worker directory', async () => {
    const attachmentRoot = await mkdtemp(path.join(os.tmpdir(), 'parallel-attachment-'));
    const attachment = path.join(attachmentRoot, 'input.txt');
    await writeFile(attachment, 'attachment-content');
    const cases = Array.from({ length: PARALLEL_CASE_COUNT }, (_, index) => [
      `  - id: isolated-${index}`,
      '    type: task',
      `    prompt: isolated-${index}`,
      '    setup:',
      `      - "echo setup-${index} > setup-${index}.txt"`,
      '    files:',
      `      - source: ${attachment}`,
      `        dest: input-${index}.txt`,
      '    expect:',
      `      file_exists: [setup-${index}.txt, input-${index}.txt]`,
    ].join('\n'));
    const { root, casesDir, workDir } = await createSuiteRoot([
      'name: isolated-workers',
      'cases:',
      ...cases,
      '',
    ].join('\n'));
    const factoryDirectories: string[] = [];
    const caseDirectories = new Map<string, string>();

    const runner = new TestRunner(
      parallelConfig(root, casesDir, workDir),
      makeSerialAgent(),
      ({ workingDirectory }) => {
        factoryDirectories.push(workingDirectory);
        return passingAgent(async (prompt) => {
          const index = prompt.split('-')[1];
          expect(await readFile(path.join(workingDirectory, `setup-${index}.txt`), 'utf8'))
            .toContain(`setup-${index}`);
          expect(await readFile(path.join(workingDirectory, `input-${index}.txt`), 'utf8'))
            .toBe('attachment-content');
          caseDirectories.set(prompt, workingDirectory);
          return { responses: ['ok'], toolExecutions: [], turnCount: 1, errors: [] };
        });
      },
    );

    const summary = await runner.runAll();

    expect(summary.passed).toBe(PARALLEL_CASE_COUNT);
    expect(factoryDirectories.length).toBeGreaterThanOrEqual(2);
    expect(new Set(factoryDirectories).size).toBe(factoryDirectories.length);
    expect(new Set(caseDirectories.values()).size).toBeGreaterThanOrEqual(2);
    for (const workerDirectory of factoryDirectories) {
      expect(workerDirectory).not.toBe(workDir);
      await expect(access(workerDirectory)).rejects.toThrow();
    }
  });
});
