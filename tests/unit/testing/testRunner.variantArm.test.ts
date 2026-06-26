// ============================================================================
// audit D-R3：eval run metadata 记录 provider 变体臂
// ============================================================================
// CODE_AGENT_DISABLE_PROVIDER_VARIANT 是 2.4 A/B 对照的开关，但 run metadata
// 此前无 variant 维度 —— 跑了也无法归因。summary.environment.providerVariantArm
// 落进 saveReport / DB，两臂结果才可对比。
// ============================================================================

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

async function runMinimalSuite(): Promise<ReturnType<TestRunner['runAll']>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-variant-arm-'));
  const casesDir = path.join(root, 'cases');
  const resultsDir = path.join(root, 'results');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), [
    'name: variant-arm',
    'cases:',
    '  - id: variant-arm-case',
    '    type: task',
    '    description: minimal case for metadata test',
    '    prompt: say ok',
    '    expect:',
    '      response_contains: [ok]',
    '',
  ].join('\n'));

  const agent: AgentInterface = {
    sendMessage: vi.fn(async () => ({
      responses: ['ok'],
      toolExecutions: [],
      turnCount: 1,
      errors: [],
    })),
    reset: vi.fn(async () => undefined),
    getAgentInfo: () => ({ name: 'mock-agent', model: 'mock-model', provider: 'mock' }),
    getSessionId: () => 'session-variant-arm',
    finalizeSession: vi.fn(async () => undefined),
  };

  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir,
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

afterEach(() => {
  delete process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT;
});

describe('TestRunner provider variant arm metadata (audit D-R3)', () => {
  it('records variant-on when the disable flag is unset', async () => {
    delete process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT;
    const summary = await runMinimalSuite();
    expect(summary.environment.providerVariantArm).toBe('variant-on');
  });

  it('records variant-off when CODE_AGENT_DISABLE_PROVIDER_VARIANT=1', async () => {
    process.env.CODE_AGENT_DISABLE_PROVIDER_VARIANT = '1';
    const summary = await runMinimalSuite();
    expect(summary.environment.providerVariantArm).toBe('variant-off');
  });
});
