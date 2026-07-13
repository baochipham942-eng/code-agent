import { describe, expect, it } from 'vitest';
import {
  activateArtifactRepairAdmissionStop,
  registerArtifactRepairBlockedToolTurn,
  ARTIFACT_REPAIR_STOP_PREFIXES,
} from '../../../src/host/agent/runtime/artifactRepairAdmission';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../src/shared/constants/repair';
import { ControlState } from '../../../src/host/agent/runtime/controlState';

function makeCtx(): any {
  return { control: ControlState.forTest() };
}

describe('activateArtifactRepairAdmissionStop — Route A 硬停闸', () => {
  it('unavailable-tool 停闸：用对应前缀写入 forceFinalResponseReason/Prompt', () => {
    const ctx = makeCtx();
    activateArtifactRepairAdmissionStop(ctx, '/tmp/game.html', 'Grep, Bash');

    expect(ctx.control.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool']} Grep, Bash`,
    );
    expect(ctx.control.forceFinalResponsePrompt).toContain('<force-final-response');
    expect(ctx.control.forceFinalResponsePrompt).toContain('/tmp/game.html');
    expect(ctx.control.forceFinalResponsePrompt).toContain('repeatedly requested unavailable tool');
  });

  it('attempts-exhausted 停闸：用独立前缀和措辞', () => {
    const ctx = makeCtx();
    const detail = `${ARTIFACT_REPAIR_MAX_ATTEMPTS}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} attempts`;
    activateArtifactRepairAdmissionStop(ctx, '/tmp/game.html', detail, 'attempts-exhausted');

    expect(ctx.control.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']} ${detail}`,
    );
    expect(ctx.control.forceFinalResponseReason.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'])).toBe(false);
    expect(ctx.control.forceFinalResponsePrompt).toContain('reached its attempt limit');
  });

  it('两种停闸前缀互不重叠，UI 处理器可区分', () => {
    expect(ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool']).not.toBe(
      ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'],
    );
    expect(
      ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'].startsWith(
        ARTIFACT_REPAIR_STOP_PREFIXES['unavailable-tool'],
      ),
    ).toBe(false);
  });
});

describe('registerArtifactRepairBlockedToolTurn — block 路径循环断路器', () => {
  function makeGuardCtx(blockedToolTurnsWithoutProgress?: number): any {
    return {
      control: ControlState.forTest(),
      artifactRepairGuard: {
        targetFile: '/tmp/code-agent/games/game.html',
        attempts: 0,
        phase: 'initial_repair',
        ...(blockedToolTurnsWithoutProgress != null ? { blockedToolTurnsWithoutProgress } : {}),
      },
    };
  }

  it('累加 blockedToolTurnsWithoutProgress，未到上限不停闸', () => {
    const ctx = makeGuardCtx(0);
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifactRepairGuard, 'Read');
    expect(stopped).toBe(false);
    expect(ctx.artifactRepairGuard.blockedToolTurnsWithoutProgress).toBe(1);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('连续 block 到 ARTIFACT_REPAIR_MAX_ATTEMPTS 触发 attempts-exhausted 硬停（修复 block 路径不喂计数器的死锁缺口）', () => {
    const ctx = makeGuardCtx(ARTIFACT_REPAIR_MAX_ATTEMPTS - 1);
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifactRepairGuard, 'List');
    expect(stopped).toBe(true);
    expect(ctx.artifactRepairGuard.blockedToolTurnsWithoutProgress).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(ctx.control.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']} ${ARTIFACT_REPAIR_MAX_ATTEMPTS}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} blocked tool calls`,
    );
    expect(ctx.control.forceFinalResponsePrompt).toContain('reached its attempt limit');
  });

  it('独立于 repairTurnsWithoutProgress：即便每回合被 messageProcessor 清零，仍能累积到硬停（审计 HIGH-1 回归）', () => {
    // 复现真实死锁：guard 锁了不可达目标，模型每回合都挑可用工具(被 messageProcessor
    // 的 649 reset 把 repairTurnsWithoutProgress 清零)，但每个工具都被 repair 闸 block。
    const ctx = makeGuardCtx(0);
    let stopped = false;
    for (let turn = 0; turn < ARTIFACT_REPAIR_MAX_ATTEMPTS; turn += 1) {
      // 模拟 messageProcessor.ts:650 每回合无条件清零 repairTurnsWithoutProgress
      ctx.artifactRepairGuard.repairTurnsWithoutProgress = 0;
      stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifactRepairGuard, 'Write');
    }
    expect(stopped).toBe(true);
    expect(ctx.artifactRepairGuard.blockedToolTurnsWithoutProgress).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(ctx.control.forceFinalResponseReason?.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'])).toBe(true);
  });

  it('无 guard 时安全 no-op', () => {
    const ctx = makeCtx();
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, undefined, 'Read');
    expect(stopped).toBe(false);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });
});
