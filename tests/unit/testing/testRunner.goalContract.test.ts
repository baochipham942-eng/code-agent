// ============================================================================
// B6b-①：TestRunner goal_contract 集成（真实 YAML loader + 全链）
// ============================================================================
// - 配置错误（无判据 / 与 user_simulation·follow_up_prompts 互斥）→ fail-loud，
//   零 agent 调用（对齐批 6 user_simulation 口径）
// - 合法契约 → 每 case 经 configureGoalContract 注入（无契约 case 传 undefined
//   清除上个 case 的配置），run 后 getGoalRunRecord 落 result.goalRun
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { EvalGoalContract, GoalRunRecord } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function goalAgent(record?: GoalRunRecord): AgentInterface & {
  prompts: string[];
  configuredContracts: Array<EvalGoalContract | undefined>;
} {
  const prompts: string[] = [];
  const configuredContracts: Array<EvalGoalContract | undefined> = [];
  let activeRecord: GoalRunRecord | undefined;
  return {
    prompts,
    configuredContracts,
    sendMessage: async (prompt: string) => {
      prompts.push(prompt);
      if (configuredContracts[configuredContracts.length - 1]) {
        activeRecord = record ?? { status: 'met', degraded: false, gateEvents: [] };
      }
      return { responses: ['done'], toolExecutions: [], turnCount: 1, errors: [] };
    },
    reset: async () => { activeRecord = undefined; },
    getAgentInfo: () => ({ name: 'scripted', model: 'scripted-model', provider: 'mock' }),
    configureGoalContract: (contract: EvalGoalContract | undefined) => {
      configuredContracts.push(contract);
    },
    getGoalRunRecord: () => activeRecord,
  };
}

async function runSuite(yaml: string[], agent: AgentInterface) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-goal-contract-'));
  const casesDir = path.join(root, 'cases');
  await mkdir(casesDir, { recursive: true });
  await writeFile(path.join(casesDir, 'suite.yaml'), yaml.join('\n'));
  const runner = new TestRunner({
    testCaseDir: casesDir,
    resultsDir: path.join(root, 'results'),
    workingDirectory: root,
    defaultTimeout: 5000,
    stopOnFailure: false,
    verbose: false,
    parallel: false,
    maxParallel: 1,
    enableEvalCritic: false,
  }, agent);
  return runner.runAll();
}

describe('TestRunner goal_contract integration', () => {
  it('injects the contract per case and clears it for non-goal cases', async () => {
    const agent = goalAgent();
    const report = await runSuite([
      'name: goal-suite',
      'cases:',
      '  - id: goal-case',
      '    type: task',
      '    description: goal case',
      '    prompt: "创建 x.txt"',
      '    goal_contract:',
      '      verify_command: "test -f x.txt"',
      '      max_turns: 9',
      '    expect: {}',
      '  - id: plain-case',
      '    type: task',
      '    description: plain case',
      '    prompt: "普通任务"',
      '    expect: {}',
    ], agent);
    expect(report.total).toBe(2);
    expect(agent.configuredContracts).toEqual([
      { verify_command: 'test -f x.txt', max_turns: 9 },
      undefined,
    ]);
  });

  it('records the goal run on the result for assertion consumption', async () => {
    const agent = goalAgent({
      status: 'met',
      degraded: true,
      degradedReason: 'budget exhausted',
      gateEvents: [{ gate: 1, pass: false, verdict: 'exhausted_release' }],
    });
    const report = await runSuite([
      'name: goal-suite',
      'cases:',
      '  - id: goal-case',
      '    type: task',
      '    description: goal case',
      '    prompt: "做任务"',
      '    goal_contract:',
      '      verify_command: "false"',
      '    expect: {}',
    ], agent);
    const result = report.results.find((r) => r.testId === 'goal-case');
    expect(result?.goalRun?.status).toBe('met');
    expect(result?.goalRun?.degraded).toBe(true);
    expect(result?.goalRun?.gateEvents).toEqual([
      { gate: 1, pass: false, verdict: 'exhausted_release' },
    ]);
  });

  it('fails loud on goal_contract without any completion criterion (zero agent calls)', async () => {
    const agent = goalAgent();
    const report = await runSuite([
      'name: goal-suite',
      'cases:',
      '  - id: bad-contract',
      '    type: task',
      '    description: no criterion',
      '    prompt: "做任务"',
      '    goal_contract: {}',
      '    expect: {}',
    ], agent);
    const result = report.results.find((r) => r.testId === 'bad-contract');
    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toMatch(/verify_command|review_condition/);
    expect(agent.prompts).toHaveLength(0);
  });

  it('fails loud when combined with user_simulation (zero agent calls)', async () => {
    const agent = goalAgent();
    const report = await runSuite([
      'name: goal-suite',
      'cases:',
      '  - id: bad-combo',
      '    type: task',
      '    description: goal + sim',
      '    prompt: "做任务"',
      '    goal_contract:',
      '      verify_command: "true"',
      '    user_simulation:',
      '      rules:',
      '        - id: r1',
      '          when:',
      '            question_asked: true',
      '          respond: "ok"',
      '    expect: {}',
    ], agent);
    const result = report.results.find((r) => r.testId === 'bad-combo');
    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toMatch(/user_simulation/);
    expect(agent.prompts).toHaveLength(0);
  });

  it('fails loud when combined with follow_up_prompts (zero agent calls)', async () => {
    const agent = goalAgent();
    const report = await runSuite([
      'name: goal-suite',
      'cases:',
      '  - id: bad-followup',
      '    type: task',
      '    description: goal + follow-ups',
      '    prompt: "做任务"',
      '    follow_up_prompts:',
      '      - "继续"',
      '    goal_contract:',
      '      verify_command: "true"',
      '    expect: {}',
    ], agent);
    const result = report.results.find((r) => r.testId === 'bad-followup');
    expect(result?.status).toBe('failed');
    expect(result?.failureReason).toMatch(/follow_up_prompts/);
    expect(agent.prompts).toHaveLength(0);
  });
});
