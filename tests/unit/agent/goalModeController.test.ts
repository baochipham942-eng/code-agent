// ============================================================================
// GoalModeController 单测 — 长程稳定性增强（①墙钟预算 / ②audit 自适应）
// 设计见 docs/decisions/goal-longrun-stability（PR1）
// ============================================================================

import { describe, expect, it } from 'vitest';
import { buildGoalContract, GoalModeController } from '../../../src/host/agent/goalModeController';
import { GOAL_MODE } from '../../../src/shared/constants';

function ctrl(opts?: {
  wallClockBudgetMs?: number;
  verifyCommand?: string;
  reviewCondition?: string;
  maxTurns?: number;
}): GoalModeController {
  return new GoalModeController(
    buildGoalContract({
      goal: '长任务',
      verifyCommand: opts?.verifyCommand ?? (opts?.reviewCondition ? undefined : 'npm test'),
      reviewCondition: opts?.reviewCondition,
      tokenBudget: 1_000_000,
      maxTurns: opts?.maxTurns ?? 100,
      wallClockBudgetMs: opts?.wallClockBudgetMs,
    }),
  );
}

describe('① 墙钟预算 — evaluateFallback', () => {
  it('未设墙钟预算 → 不因时间中止（纯加法，旧行为不变）', () => {
    const r = ctrl().evaluateFallback({ turn: 1, tokensUsed: 0, elapsedMs: 999_999_999 });
    expect(r.stop).toBe(false);
  });

  it('已用时间 < 墙钟预算 → 不中止', () => {
    const r = ctrl({ wallClockBudgetMs: 600_000 }).evaluateFallback({ turn: 1, tokensUsed: 0, elapsedMs: 100_000 });
    expect(r.stop).toBe(false);
  });

  it('已用时间 ≥ 墙钟预算 → 中止且 reason 标明时间', () => {
    const r = ctrl({ wallClockBudgetMs: 600_000 }).evaluateFallback({ turn: 1, tokensUsed: 0, elapsedMs: 600_000 });
    expect(r.stop).toBe(true);
    expect(r.reason).toMatch(/时间|墙钟|分钟/);
  });

  it('缺省 elapsedMs（旧调用方未传）→ 墙钟分支跳过，行为不变', () => {
    const r = ctrl({ wallClockBudgetMs: 600_000 }).evaluateFallback({ turn: 1, tokensUsed: 0 });
    expect(r.stop).toBe(false);
  });
});

describe('③ 闸修复预算 — 有界修复与到限放行（三分支裁决）', () => {
  it('初始修复预算未耗尽，计数为 0', () => {
    const c = ctrl();
    expect(c.getGateFailureCount()).toBe(0);
    expect(c.isGateRepairExhausted()).toBe(false);
  });

  it('recordGateFailure 递增并返回累计次数，达 GATE_REPAIR_MAX_ATTEMPTS 即耗尽', () => {
    const c = ctrl();
    for (let i = 1; i <= GOAL_MODE.GATE_REPAIR_MAX_ATTEMPTS; i++) {
      expect(c.recordGateFailure()).toBe(i);
    }
    expect(c.isGateRepairExhausted()).toBe(true);
  });

  it('markMetDegraded → status met + 降级标记 + 保留原因（到限放行，绝不无限阻塞）', () => {
    const c = ctrl();
    c.markMetDegraded('验证命令 2 次修复后仍未通过');
    expect(c.getStatus()).toBe('met');
    expect(c.isPending()).toBe(false);
    expect(c.isVerificationDegraded()).toBe(true);
    expect(c.getDegradedReason()).toMatch(/未通过/);
  });

  it('正常 markMet → 无降级标记', () => {
    const c = ctrl();
    c.markMet();
    expect(c.getStatus()).toBe('met');
    expect(c.isVerificationDegraded()).toBe(false);
  });
});

describe('② audit 自适应 — shouldInjectAudit', () => {
  it('复杂 goal（有 verifyCommand）→ 维持基础间隔，第 N 轮注入', () => {
    const c = ctrl({ verifyCommand: 'npm test' });
    const base = GOAL_MODE.CHECKPOINT_INTERVAL;
    expect(c.shouldInjectAudit(base)).toBe(true);
    expect(c.shouldInjectAudit(1)).toBe(false); // 首轮永不注入
  });

  it('简单 goal（纯软目标 + 轮次少）→ 间隔拉长，基础间隔轮不再注入', () => {
    const c = ctrl({ reviewCondition: '文案口吻更亲切', maxTurns: 10 });
    // 简单 goal 的 audit 间隔应大于基础间隔 → 第 CHECKPOINT_INTERVAL 轮不应注入
    expect(c.shouldInjectAudit(GOAL_MODE.CHECKPOINT_INTERVAL)).toBe(false);
  });

  it('简单 goal 仍会在其（更长的）间隔轮注入，不是永不自检', () => {
    const c = ctrl({ reviewCondition: '文案口吻更亲切', maxTurns: 10 });
    const interval = GOAL_MODE.SIMPLE_CHECKPOINT_INTERVAL;
    expect(c.shouldInjectAudit(interval)).toBe(true);
  });
});
