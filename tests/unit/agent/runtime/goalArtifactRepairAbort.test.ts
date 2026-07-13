import { describe, expect, it } from 'vitest';
import {
  decideArtifactRepairStrategy,
  getArtifactValidationFailureMap,
  getGoalArtifactRepairReleaseReason,
  type ArtifactValidationFailureState,
} from '../../../../src/host/agent/runtime/toolArtifactRepairPolicy';
import {
  ARTIFACT_REPAIR_MAX_ATTEMPTS,
  ARTIFACT_REPAIR_PATIENCE_ROUNDS,
} from '../../../../src/shared/constants/repair';
import { GOAL_MODE } from '../../../../src/shared/constants/agent';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';
import { ArtifactState } from '../../../../src/host/agent/runtime/artifactState';

const BACKSTOP = ARTIFACT_REPAIR_MAX_ATTEMPTS * GOAL_MODE.ARTIFACT_REPAIR_GOAL_ABORT_MULTIPLIER;

function makeCtx(): RuntimeContext {
  // failureMap 已收进 ArtifactState 切片，loose ctx 必须带真实 artifact 实例
  return { workingDirectory: '/tmp', artifact: ArtifactState.forTest() } as unknown as RuntimeContext;
}

function makeState(overrides: Partial<ArtifactValidationFailureState> = {}): ArtifactValidationFailureState {
  return { attempts: 1, phase: 'baseline_repair', ...overrides };
}

describe('decideArtifactRepairStrategy（patience + 修复/重写双信号）', () => {
  it('失败项持续下降（有净进展）→ 继续修复', () => {
    const state = makeState();
    expect(decideArtifactRepairStrategy({ state, failureCount: 10, issueCodes: ['canvas_not_responsive'], goalPending: true }).kind).toBe('continue_repair');
    expect(decideArtifactRepairStrategy({ state, failureCount: 6, issueCodes: ['canvas_not_responsive'], goalPending: true }).kind).toBe('continue_repair');
    expect(state.bestFailureCount).toBe(6);
    expect(state.roundsSinceBest).toBe(0);
  });

  it('补丁抗性失败码连续存活 → 不等 patience 直接切重写（复现踩敌机制 3 轮修不动）', () => {
    const state = makeState();
    // 第 1 轮出现 run_smoke_failed
    expect(decideArtifactRepairStrategy({ state, failureCount: 20, issueCodes: ['run_smoke_failed'], goalPending: true }).kind).toBe('continue_repair');
    // 第 2 轮仍在（失败数还在降=有净进展，但抗性信号优先）
    const decision = decideArtifactRepairStrategy({ state, failureCount: 14, issueCodes: ['run_smoke_failed'], goalPending: true });
    expect(decision.kind).toBe('switch_rewrite');
    expect(decision.kind === 'switch_rewrite' && decision.resistantCodes).toContain('run_smoke_failed');
  });

  it('patience 耗尽（连续 2 轮未刷新最佳）→ 切重写', () => {
    const state = makeState();
    decideArtifactRepairStrategy({ state, failureCount: 8, issueCodes: ['canvas_not_responsive'], goalPending: true });
    // 换成补丁友好码避免抗性信号干扰；连续两轮 22 没刷新 8 的最佳
    decideArtifactRepairStrategy({ state, failureCount: 22, issueCodes: ['html_incomplete'], goalPending: true });
    const decision = decideArtifactRepairStrategy({ state, failureCount: 22, issueCodes: ['trailing_after_html'], goalPending: true });
    expect(decision.kind).toBe('switch_rewrite');
    expect(state.roundsSinceBest).toBe(ARTIFACT_REPAIR_PATIENCE_ROUNDS);
  });

  it('重写机会已用仍不收敛 + goal 模式 → 降级放行', () => {
    const state = makeState({ rewriteAttempted: true, bestFailureCount: 5, roundsSinceBest: ARTIFACT_REPAIR_PATIENCE_ROUNDS });
    const decision = decideArtifactRepairStrategy({ state, failureCount: 7, issueCodes: ['run_smoke_failed', 'run_smoke_failed'], goalPending: true });
    expect(decision.kind).toBe('degraded_release');
  });

  it('重写后失败码消失、成绩刷新 → 回到继续修复', () => {
    const state = makeState({ rewriteAttempted: true, bestFailureCount: 14, roundsSinceBest: 1, failureCodeStreaks: { run_smoke_failed: 2 } });
    const decision = decideArtifactRepairStrategy({ state, failureCount: 2, issueCodes: ['canvas_not_responsive'], goalPending: true });
    expect(decision.kind).toBe('continue_repair');
    expect(state.failureCodeStreaks?.run_smoke_failed).toBeUndefined();
  });
});

describe('getGoalArtifactRepairReleaseReason（goal 降级放行判据）', () => {
  it('策略裁决置位 degradedReleasePending → 返回放行理由', () => {
    const ctx = makeCtx();
    getArtifactValidationFailureMap(ctx).set('/tmp/game.html', makeState({ degradedReleasePending: '修复与重写均未收敛' }));

    const reason = getGoalArtifactRepairReleaseReason(ctx);
    expect(reason).toContain('修复与重写均未收敛');
    expect(reason).toContain('/tmp/game.html');
  });

  it('attempts 达 2×上限兜底 → 返回放行理由（复现 dogfood 第6/4次盲修）', () => {
    const ctx = makeCtx();
    getArtifactValidationFailureMap(ctx).set('/tmp/game.html', makeState({ attempts: BACKSTOP }));

    expect(getGoalArtifactRepairReleaseReason(ctx)).toContain('降级放行');
  });

  it('未触发任何判据 → null', () => {
    const ctx = makeCtx();
    getArtifactValidationFailureMap(ctx).set('/tmp/game.html', makeState({ attempts: BACKSTOP - 1 }));

    expect(getGoalArtifactRepairReleaseReason(ctx)).toBeNull();
  });
});
