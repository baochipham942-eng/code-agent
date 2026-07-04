// ============================================================================
// 批 6 · B6a：TestRunner 条件应答集成（follow_up_prompts 的升级形态）
// ============================================================================
// 走真实 YAML loader + TestRunner 全链，agent 用脚本化 fake：
// - 规则命中 → 把 respond 作为下一轮 user 输入发送（多轮条件应答）
// - stop 语义 → 不再发送（模拟用户拒绝后离开）
// - 非法 user_simulation / 与 follow_up_prompts 同时出现 → fail-loud，零 agent 调用
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { TestRunner, type AgentInterface } from '../../../src/host/testing/testRunner';
import type { ToolExecutionRecord } from '../../../src/host/testing/types';

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    insertExperiment: vi.fn(),
    insertExperimentCases: vi.fn(),
  }),
}));

function toolExec(tool: string): ToolExecutionRecord {
  return { tool, input: {}, output: '', success: true, duration: 1, timestamp: Date.now() };
}

interface ScriptedTurn {
  responses: string[];
  toolExecutions?: ToolExecutionRecord[];
  errors?: string[];
}

function scriptedAgent(script: ScriptedTurn[]): AgentInterface & { prompts: string[] } {
  const prompts: string[] = [];
  let cursor = 0;
  const agent = {
    prompts,
    sendMessage: async (prompt: string) => {
      prompts.push(prompt);
      const turn = script[cursor] ?? { responses: ['[script exhausted]'] };
      cursor += 1;
      return {
        responses: turn.responses,
        toolExecutions: turn.toolExecutions ?? [],
        turnCount: 1,
        errors: turn.errors ?? [],
      };
    },
    reset: async () => undefined,
    getAgentInfo: () => ({ name: 'scripted', model: 'scripted-model', provider: 'mock' }),
  };
  return agent;
}

async function runSuite(yaml: string[], agent: AgentInterface) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'code-agent-user-sim-'));
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

describe('TestRunner user_simulation conditional follow-ups', () => {
  it('approve branch: rule fires on AskUserQuestion, respond is sent as next user turn', async () => {
    const agent = scriptedAgent([
      { responses: ['需要确认：可以创建文件吗？'], toolExecutions: [toolExec('AskUserQuestion')] },
      { responses: ['done'], toolExecutions: [toolExec('Write')] },
    ]);
    const summary = await runSuite([
      'name: sim-approve',
      'cases:',
      '  - id: sim-approve-case',
      '    type: task',
      '    description: approve branch',
      '    prompt: create a file after confirming',
      '    user_simulation:',
      '      rules:',
      '        - id: approve-rule',
      '          when:',
      '            question_asked: true',
      '          respond: 批准，继续',
      '    expect:',
      '      response_contains: [done]',
      '',
    ], agent);

    const result = summary.results[0];
    expect(agent.prompts).toEqual(['create a file after confirming', '批准，继续']);
    expect(result.status).toBe('passed');
    expect(result.simTurns).toHaveLength(1);
    expect(result.simTurns?.[0]).toMatchObject({
      ruleId: 'approve-rule',
      action: 'respond',
      message: '批准，继续',
      // 快照在发送应答之前：初轮已有 1 个 toolExecution / 1 条 response
      toolExecutionsBefore: 1,
      responsesBefore: 1,
    });
    // 两轮产出全部累进结果
    expect(result.responses).toEqual(['需要确认：可以创建文件吗？', 'done']);
    expect(result.toolExecutions.map((t) => t.tool)).toEqual(['AskUserQuestion', 'Write']);
  });

  it('reject branch: respond+stop sends the rejection then stops even if next turn matches again', async () => {
    const agent = scriptedAgent([
      { responses: ['可以开始吗？'], toolExecutions: [toolExec('AskUserQuestion')] },
      // agent 无视拒绝又问了一次 —— stop 语义下不许再应答
      { responses: ['真的不做了吗？'], toolExecutions: [toolExec('AskUserQuestion')] },
    ]);
    const summary = await runSuite([
      'name: sim-reject',
      'cases:',
      '  - id: sim-reject-case',
      '    type: task',
      '    description: reject branch',
      '    prompt: do something risky',
      '    user_simulation:',
      '      rules:',
      '        - id: reject-rule',
      '          when:',
      '            question_asked: true',
      '          respond: 不批准，停止，不要做任何修改',
      '          stop: true',
      '          max_matches: 5',
      '    expect:',
      '      response_contains: [吗]',
      '',
    ], agent);

    const result = summary.results[0];
    // 初轮 + 拒绝应答一轮 = 2 次 sendMessage，stop 后绝不发第三次
    expect(agent.prompts).toHaveLength(2);
    expect(agent.prompts[1]).toBe('不批准，停止，不要做任何修改');
    expect(result.simTurns?.map((t) => t.action)).toEqual(['respond', 'stop']);
  });

  it('change-request branch: sequential rules drive multi-turn revision flow', async () => {
    const agent = scriptedAgent([
      { responses: ['方案 A：写 a.txt，可以吗？'], toolExecutions: [toolExec('AskUserQuestion')] },
      { responses: ['好的，改为方案 B：写 b.txt，确认？'], toolExecutions: [toolExec('AskUserQuestion')] },
      { responses: ['done b.txt'], toolExecutions: [toolExec('Write')] },
    ]);
    const summary = await runSuite([
      'name: sim-change',
      'cases:',
      '  - id: sim-change-case',
      '    type: task',
      '    description: change request branch',
      '    prompt: write a file with confirmation',
      '    user_simulation:',
      '      rules:',
      '        - id: change-rule',
      '          when:',
      '            response_matches: 方案 A',
      '          respond: 改需求：不要 a.txt，改成 b.txt',
      '        - id: approve-revised',
      '          when:',
      '            response_matches: 方案 B',
      '          respond: 批准',
      '    expect:',
      '      response_contains: [done]',
      '',
    ], agent);

    const result = summary.results[0];
    expect(agent.prompts).toEqual([
      'write a file with confirmation',
      '改需求：不要 a.txt，改成 b.txt',
      '批准',
    ]);
    expect(result.status).toBe('passed');
    expect(result.simTurns?.map((t) => t.ruleId)).toEqual(['change-rule', 'approve-revised']);
  });

  it('no rule matches → no extra turns, conversation ends after initial prompt', async () => {
    const agent = scriptedAgent([
      { responses: ['直接做完了'], toolExecutions: [toolExec('Write')] },
    ]);
    const summary = await runSuite([
      'name: sim-nomatch',
      'cases:',
      '  - id: sim-nomatch-case',
      '    type: task',
      '    description: no match',
      '    prompt: just do it',
      '    user_simulation:',
      '      rules:',
      '        - id: q-rule',
      '          when:',
      '            question_asked: true',
      '          respond: 批准',
      '    expect:',
      '      response_contains: [做完]',
      '',
    ], agent);

    expect(agent.prompts).toHaveLength(1);
    expect(summary.results[0].simTurns).toEqual([]);
  });

  it('max_turns caps the total simulated reply turns', async () => {
    const agent = scriptedAgent([
      { responses: ['继续？'] },
      { responses: ['继续？'] },
      { responses: ['继续？'] },
      { responses: ['继续？'] },
      { responses: ['继续？'] },
    ]);
    const summary = await runSuite([
      'name: sim-cap',
      'cases:',
      '  - id: sim-cap-case',
      '    type: task',
      '    description: cap',
      '    prompt: loop forever',
      '    user_simulation:',
      '      max_turns: 2',
      '      rules:',
      '        - id: loop-rule',
      '          when:',
      '            response_matches: 继续',
      '          respond: 继续',
      '          max_matches: 99',
      '    expect:',
      '      response_contains: [继续]',
      '',
    ], agent);

    // 初轮 + 最多 2 轮模拟应答
    expect(agent.prompts).toHaveLength(3);
    expect(summary.results[0].simTurns).toHaveLength(2);
  });

  it('invalid user_simulation fails loud without spending any agent calls', async () => {
    const agent = scriptedAgent([{ responses: ['should never run'] }]);
    const summary = await runSuite([
      'name: sim-invalid',
      'cases:',
      '  - id: sim-invalid-case',
      '    type: task',
      '    description: invalid sim',
      '    prompt: anything',
      '    user_simulation:',
      '      rules: []',
      '    expect:',
      '      response_contains: [anything]',
      '',
    ], agent);

    const result = summary.results[0];
    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/user_simulation/);
    expect(agent.prompts).toHaveLength(0);
  });

  it('user_simulation combined with follow_up_prompts fails loud (ambiguous multi-turn semantics)', async () => {
    const agent = scriptedAgent([{ responses: ['should never run'] }]);
    const summary = await runSuite([
      'name: sim-conflict',
      'cases:',
      '  - id: sim-conflict-case',
      '    type: task',
      '    description: conflicting multi-turn config',
      '    prompt: anything',
      '    follow_up_prompts:',
      '      - and then',
      '    user_simulation:',
      '      rules:',
      '        - id: r1',
      '          when:',
      '            question_asked: true',
      '          respond: ok',
      '    expect:',
      '      response_contains: [anything]',
      '',
    ], agent);

    const result = summary.results[0];
    expect(result.status).toBe('failed');
    expect(result.failureReason).toMatch(/follow_up_prompts/);
    expect(agent.prompts).toHaveLength(0);
  });

  it('passes user_simulation to adapters that support configureUserSimulation', async () => {
    const configure = vi.fn();
    const base = scriptedAgent([
      { responses: ['ok'] },
    ]);
    const agent: AgentInterface = { ...base, configureUserSimulation: configure };
    await runSuite([
      'name: sim-configure',
      'cases:',
      '  - id: sim-configure-case',
      '    type: task',
      '    description: adapter wiring',
      '    prompt: hello',
      '    user_simulation:',
      '      permission_policy: reject',
      '      rules:',
      '        - id: r1',
      '          when:',
      '            question_asked: true',
      '          respond: ok',
      '    expect:',
      '      response_contains: [ok]',
      '',
    ], agent);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure.mock.calls[0][0]).toMatchObject({ permission_policy: 'reject' });
  });
});
