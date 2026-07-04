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

/** goal 断言求值结果（assertionEngine 的 ExpectationResult.evidence 子集） */
export interface GoalExpectationEvaluation {
  passed: boolean;
  actual: string;
  expected: string;
  details?: string;
}

/**
 * goal_status 断言：pin 终态枚举 + degraded 布尔（区分「验证全过的 met」与
 * 「修复预算耗尽的降级放行」）。只 pin 行为信号不 pin 文案。
 * fail-loud：缺参 / case 没配 goal_contract（goalRun 缺失，Mock 态即此形态）/
 * run 结束终态事件没发，一律显式 fail —— 绝不假绿。
 */
export function evaluateGoalStatusExpectation(
  params: Record<string, unknown>,
  goalRun: GoalRunRecord | undefined,
): GoalExpectationEvaluation {
  const expectedStatus = params.expected;
  if (expectedStatus !== 'met' && expectedStatus !== 'aborted') {
    return {
      passed: false,
      actual: `invalid params: expected must be "met" or "aborted" (got ${JSON.stringify(params.expected)})`,
      expected: 'valid goal_status params',
    };
  }
  if (params.degraded !== undefined && typeof params.degraded !== 'boolean') {
    return {
      passed: false,
      actual: 'invalid params: degraded must be a boolean when provided',
      expected: 'valid goal_status params',
    };
  }
  const expected = `goal terminal status "${expectedStatus}"${params.degraded !== undefined ? ` with degraded=${params.degraded}` : ''}`;
  if (!goalRun) {
    return { passed: false, actual: 'case ran without goal_contract (no goal run recorded)', expected };
  }
  if (!goalRun.status) {
    return { passed: false, actual: 'goal run ended without a terminal goal_complete event', expected };
  }
  const degradedActual = goalRun.degraded ?? false;
  return {
    passed: goalRun.status === expectedStatus
      && (params.degraded === undefined || degradedActual === params.degraded),
    actual: `status=${goalRun.status} degraded=${degradedActual}`,
    expected,
    details: goalRun.degradedReason
      ? `degradedReason: ${goalRun.degradedReason.substring(0, 200)}`
      : goalRun.abortReason
        ? `abortReason: ${goalRun.abortReason.substring(0, 200)}`
        : undefined,
  };
}

/**
 * goal_evidence_gate 断言：pin 闸0（证据自证核验）末次 verdict + 打回次数下限。
 * exhausted_release 与 allow_finalize 都 pass=true，verdict 是唯一可区分信号
 * （闸0 事件的 verdict 映射见 goalCompletionGate）。同 goal_status 的 fail-loud 口径。
 */
export function evaluateGoalEvidenceGateExpectation(
  params: Record<string, unknown>,
  goalRun: GoalRunRecord | undefined,
): GoalExpectationEvaluation {
  const expectedVerdict = params.expected_verdict;
  if (
    expectedVerdict !== 'allow_finalize' &&
    expectedVerdict !== 'repair_prompt' &&
    expectedVerdict !== 'exhausted_release'
  ) {
    return {
      passed: false,
      actual: `invalid params: expected_verdict must be allow_finalize | repair_prompt | exhausted_release (got ${JSON.stringify(params.expected_verdict)})`,
      expected: 'valid goal_evidence_gate params',
    };
  }
  const minBounces = params.min_bounces;
  if (
    minBounces !== undefined &&
    (typeof minBounces !== 'number' || !Number.isInteger(minBounces) || minBounces < 0)
  ) {
    return {
      passed: false,
      actual: 'invalid params: min_bounces must be a non-negative integer',
      expected: 'valid goal_evidence_gate params',
    };
  }
  const expected = `final gate-0 verdict "${expectedVerdict}"${minBounces !== undefined ? ` with >= ${minBounces} bounce(s)` : ''}`;
  if (!goalRun) {
    return { passed: false, actual: 'case ran without goal_contract (no goal run recorded)', expected };
  }
  const gateZero = goalRun.gateEvents.filter((e) => e.gate === 0);
  if (gateZero.length === 0) {
    return {
      passed: false,
      actual: 'evidence gate never evaluated (no gate-0 events; attempt_completion may never have been called)',
      expected,
    };
  }
  const finalVerdict = gateZero[gateZero.length - 1].verdict;
  const bounces = gateZero.filter((e) => e.verdict === 'repair_prompt').length;
  return {
    passed: finalVerdict === expectedVerdict && (minBounces === undefined || bounces >= minBounces),
    actual: `final gate-0 verdict=${finalVerdict ?? 'missing'} bounces=${bounces}`,
    expected,
    details: `gate-0 events: ${gateZero.map((e) => `${e.verdict ?? '?'}(pass=${e.pass})`).join(' → ')}`,
  };
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
    // 首个终态锁死（审计 R1-M1）：产品侧本不该双发终态，但若状态机 bug 导致
    // 二次 goal_complete，后写覆盖会把真实终态（如 aborted）洗成假绿——eval
    // 的职责是暴露这种 bug 而不是掩盖它，落账以第一次申明的终态为准。
    if (record.status) return;
    record.status = event.data.status;
    record.degraded = event.data.degraded ?? false;
    record.degradedReason = event.data.degradedReason;
    record.abortReason = event.data.reason;
  }
}
