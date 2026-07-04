// ============================================================================
// B6b-①：goal 契约接入 eval —— 纯函数层
//
// 三件事，全部无 App/IPC 依赖（可独立单测，对齐批 6 userSimulator 形态）：
// 1. validateGoalContract：case 配置错误在花任何 agent 调用之前显式失败（fail-loud）
// 2. buildLoopGoalContract：YAML snake_case → AgentLoop GoalContract（allowSwarm
//    强制 false —— eval 无人值守不扇出，对齐主动性 advance 路径）
// 3. createGoalRunRecord / applyGoalEvent：goal_gate / goal_complete 事件 →
//    GoalRunRecord 行为落账（断言只 pin 枚举/极性，不 pin 文案）
// ============================================================================

import type { AgentEvent } from '../../shared/contract';
import { buildGoalContract, type GoalContract } from '../agent/goalModeController';
import type { EvalGoalContract, GoalRunRecord, TestCase } from './types';

function isPositiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * goal_contract 配置校验：返回错误描述，合法（或没配）时返回 null。
 * goal 三闸全自动无用户节点 —— 与 user_simulation / follow_up_prompts 互斥。
 */
export function validateGoalContract(testCase: TestCase): string | null {
  const contract = testCase.goal_contract;
  if (!contract) return null;

  if (testCase.user_simulation) {
    return 'goal_contract cannot be combined with user_simulation (goal loop is fully automatic, no user node)';
  }
  if (testCase.follow_up_prompts && testCase.follow_up_prompts.length > 0) {
    return 'goal_contract cannot be combined with follow_up_prompts (goal loop drives its own turns)';
  }
  const hasVerify = typeof contract.verify_command === 'string' && contract.verify_command.trim().length > 0;
  const hasReview = typeof contract.review_condition === 'string' && contract.review_condition.trim().length > 0;
  if (!hasVerify && !hasReview) {
    return 'goal_contract requires at least one completion criterion: verify_command or review_condition';
  }
  if (contract.goal?.trim().length === 0) {
    return 'goal_contract.goal must be non-empty when provided (omit it to fall back to the case prompt)';
  }
  for (const field of ['token_budget', 'max_turns', 'wall_clock_budget_ms'] as const) {
    if (contract[field] !== undefined && !isPositiveNumber(contract[field])) {
      return `goal_contract.${field} must be a positive number`;
    }
  }
  return null;
}

/**
 * YAML 契约 → AgentLoop GoalContract。缺省预算走产品默认（buildGoalContract 内
 * 的 GOAL_MODE 常量），保证 eval 回归的就是产线闸链参数。
 */
export function buildLoopGoalContract(contract: EvalGoalContract, fallbackGoal: string): GoalContract {
  return buildGoalContract({
    goal: contract.goal?.trim() || fallbackGoal,
    verifyCommand: contract.verify_command,
    reviewCondition: contract.review_condition,
    tokenBudget: contract.token_budget,
    maxTurns: contract.max_turns,
    wallClockBudgetMs: contract.wall_clock_budget_ms,
    // eval 无人值守：不扇出 swarm 子 agent（确定性 + 成本护栏）
    allowSwarm: false,
  });
}

export function createGoalRunRecord(): GoalRunRecord {
  return { gateEvents: [] };
}

/** goal 观测事件 → 行为落账。非 goal 事件一律忽略（adapter 的 onEvent 直通调用）。 */
export function applyGoalEvent(record: GoalRunRecord, event: AgentEvent): void {
  if (event.type === 'goal_gate') {
    record.gateEvents.push({
      gate: event.data.gate,
      pass: event.data.pass,
      verdict: event.data.verdict,
    });
    return;
  }
  if (event.type === 'goal_complete') {
    record.status = event.data.status;
    record.degraded = event.data.degraded ?? false;
    record.degradedReason = event.data.degradedReason;
    record.abortReason = event.data.reason;
  }
}
