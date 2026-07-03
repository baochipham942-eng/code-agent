import { describe, expect, it } from 'vitest';
import {
  getArtifactValidationFailureMap,
  getGoalArtifactRepairAbortReason,
} from '../../../../src/host/agent/runtime/toolArtifactRepairPolicy';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../../src/shared/constants/repair';
import { GOAL_MODE } from '../../../../src/shared/constants/agent';
import type { RuntimeContext } from '../../../../src/host/agent/runtime/runtimeContext';

const ABORT_THRESHOLD = ARTIFACT_REPAIR_MAX_ATTEMPTS * GOAL_MODE.ARTIFACT_REPAIR_GOAL_ABORT_MULTIPLIER;

function makeCtx(): RuntimeContext {
  return { workingDirectory: '/tmp' } as unknown as RuntimeContext;
}

describe('getGoalArtifactRepairAbortReason（goal 盲修循环止损判据）', () => {
  it('修复次数未达 2×上限 → 不触发', () => {
    const ctx = makeCtx();
    getArtifactValidationFailureMap(ctx).set('/tmp/game.html', {
      attempts: ABORT_THRESHOLD - 1,
      phase: 'read_then_patch',
    });

    expect(getGoalArtifactRepairAbortReason(ctx)).toBeNull();
  });

  it('任一目标文件修复次数达 2×上限 → 返回中止理由（复现 dogfood 第6/4次盲修）', () => {
    const ctx = makeCtx();
    getArtifactValidationFailureMap(ctx).set('/tmp/game.html', {
      attempts: ABORT_THRESHOLD,
      phase: 'read_then_patch',
    });

    const reason = getGoalArtifactRepairAbortReason(ctx);
    expect(reason).toContain('/tmp/game.html');
    expect(reason).toContain('中止 goal');
  });

  it('无任何修复失败记录 → 不触发', () => {
    expect(getGoalArtifactRepairAbortReason(makeCtx())).toBeNull();
  });
});
