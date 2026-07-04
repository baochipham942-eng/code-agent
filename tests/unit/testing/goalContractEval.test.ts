// ============================================================================
// B6b-①：goal 契约接入 eval —— 纯函数层（校验 / 契约映射 / 事件落账 reducer）
// ============================================================================
// - validateGoalContract：配置错误在花任何 agent 调用之前显式失败（fail-loud，
//   对齐批 6 user_simulation 口径）；goal 三闸全自动无用户节点 → 与
//   user_simulation / follow_up_prompts 互斥。
// - buildLoopGoalContract：YAML snake_case → AgentLoop GoalContract；eval 无人
//   值守，allowSwarm 强制 false（对齐主动性 advance 路径）。
// - applyGoalEvent：goal_gate / goal_complete 事件 → GoalRunRecord（断言锚点
//   数据，只记行为信号不记文案）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  applyGoalEvent,
  buildLoopGoalContract,
  createGoalRunRecord,
  validateGoalContract,
} from '../../../src/host/testing/goalContractEval';
import type { TestCase } from '../../../src/host/testing/types';

function goalCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'goal-case',
    type: 'task',
    description: 'goal case',
    prompt: '创建文件 x.txt',
    expect: {},
    goal_contract: { verify_command: 'test -f x.txt' },
    ...overrides,
  };
}

describe('validateGoalContract', () => {
  it('accepts a minimal contract with verify_command only', () => {
    expect(validateGoalContract(goalCase())).toBeNull();
  });

  it('accepts a pure soft contract with review_condition only', () => {
    expect(validateGoalContract(goalCase({
      goal_contract: { review_condition: '文件内容正确' },
    }))).toBeNull();
  });

  it('rejects a contract without any completion criterion', () => {
    const error = validateGoalContract(goalCase({ goal_contract: {} }));
    expect(error).toMatch(/verify_command|review_condition/);
  });

  it('rejects combination with user_simulation (goal loop has no user node)', () => {
    const error = validateGoalContract(goalCase({
      user_simulation: { rules: [{ id: 'r1', when: { question_asked: true }, respond: 'ok' }] },
    }));
    expect(error).toMatch(/user_simulation/);
  });

  it('rejects combination with follow_up_prompts', () => {
    const error = validateGoalContract(goalCase({ follow_up_prompts: ['继续'] }));
    expect(error).toMatch(/follow_up_prompts/);
  });

  it('rejects blank goal override', () => {
    const error = validateGoalContract(goalCase({
      goal_contract: { goal: '   ', verify_command: 'true' },
    }));
    expect(error).toMatch(/goal/);
  });

  it('rejects non-positive numeric budgets', () => {
    for (const field of ['token_budget', 'max_turns', 'wall_clock_budget_ms'] as const) {
      const error = validateGoalContract(goalCase({
        goal_contract: { verify_command: 'true', [field]: 0 },
      }));
      expect(error, field).toMatch(new RegExp(field));
    }
  });

  it('returns null when the case has no goal_contract', () => {
    expect(validateGoalContract(goalCase({ goal_contract: undefined }))).toBeNull();
  });
});

describe('buildLoopGoalContract', () => {
  it('maps snake_case fields and forces allowSwarm=false (unattended eval)', () => {
    const contract = buildLoopGoalContract({
      goal: '把 x.txt 造出来',
      verify_command: 'test -f x.txt',
      review_condition: '内容非空',
      token_budget: 500_000,
      max_turns: 12,
      wall_clock_budget_ms: 120_000,
    }, 'fallback prompt');
    expect(contract.goal).toBe('把 x.txt 造出来');
    expect(contract.verifyCommand).toBe('test -f x.txt');
    expect(contract.reviewCondition).toBe('内容非空');
    expect(contract.tokenBudget).toBe(500_000);
    expect(contract.maxTurns).toBe(12);
    expect(contract.wallClockBudgetMs).toBe(120_000);
    expect(contract.allowSwarm).toBe(false);
  });

  it('falls back to the case prompt when goal is omitted', () => {
    const contract = buildLoopGoalContract({ verify_command: 'true' }, '创建文件 x.txt');
    expect(contract.goal).toBe('创建文件 x.txt');
  });

  it('applies product defaults for omitted budgets', () => {
    const contract = buildLoopGoalContract({ verify_command: 'true' }, 'p');
    expect(contract.tokenBudget).toBeGreaterThan(0);
    expect(contract.maxTurns).toBeGreaterThan(0);
    expect(contract.wallClockBudgetMs).toBeUndefined();
  });
});

describe('applyGoalEvent', () => {
  it('records goal_gate events with gate number, pass and verdict', () => {
    const record = createGoalRunRecord();
    applyGoalEvent(record, {
      type: 'goal_gate',
      data: { gate: 0, pass: false, verdict: 'repair_prompt', reason: 'x' },
    });
    applyGoalEvent(record, {
      type: 'goal_gate',
      data: { gate: 1, pass: true, verdict: 'allow_finalize' },
    });
    expect(record.gateEvents).toEqual([
      { gate: 0, pass: false, verdict: 'repair_prompt' },
      { gate: 1, pass: true, verdict: 'allow_finalize' },
    ]);
  });

  it('records goal_complete terminal state (met, degraded)', () => {
    const record = createGoalRunRecord();
    applyGoalEvent(record, {
      type: 'goal_complete',
      data: { status: 'met', turns: 6, tokensUsed: 1000, degraded: true, degradedReason: '修复预算用尽' },
    });
    expect(record.status).toBe('met');
    expect(record.degraded).toBe(true);
    expect(record.degradedReason).toBe('修复预算用尽');
  });

  it('records goal_complete aborted with reason and defaults degraded to false', () => {
    const record = createGoalRunRecord();
    applyGoalEvent(record, {
      type: 'goal_complete',
      data: { status: 'aborted', reason: '达到轮次上限', turns: 10, tokensUsed: 2000 },
    });
    expect(record.status).toBe('aborted');
    expect(record.degraded).toBe(false);
    expect(record.abortReason).toBe('达到轮次上限');
  });

  it('first terminal wins: a second goal_complete cannot overwrite the recorded terminal (audit R1-M1)', () => {
    const record = createGoalRunRecord();
    applyGoalEvent(record, {
      type: 'goal_complete',
      data: { status: 'aborted', reason: '预算耗尽', turns: 8, tokensUsed: 9000 },
    });
    applyGoalEvent(record, {
      type: 'goal_complete',
      data: { status: 'met', turns: 9, tokensUsed: 9100 },
    });
    expect(record.status).toBe('aborted');
    expect(record.abortReason).toBe('预算耗尽');
  });

  it('ignores non-goal events', () => {
    const record = createGoalRunRecord();
    applyGoalEvent(record, { type: 'agent_complete', data: null });
    expect(record.gateEvents).toHaveLength(0);
    expect(record.status).toBeUndefined();
  });
});
