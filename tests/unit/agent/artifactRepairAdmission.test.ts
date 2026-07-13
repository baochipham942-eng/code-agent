import { describe, expect, it } from 'vitest';
import {
  activateArtifactRepairAdmissionStop,
  registerArtifactRepairBlockedToolTurn,
  ARTIFACT_REPAIR_STOP_PREFIXES,
} from '../../../src/host/agent/runtime/artifactRepairAdmission';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../src/shared/constants/repair';
import { ControlState } from '../../../src/host/agent/runtime/controlState';
import { ArtifactState } from '../../../src/host/agent/runtime/artifactState';

function makeCtx(): any {
  return { control: ControlState.forTest(), artifact: ArtifactState.forTest() };
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
  function makeGuardCtx(noProgressTurns?: number): any {
    return {
      control: ControlState.forTest(),
      artifact: ArtifactState.forTest({
        repairGuard: {
        targetFile: '/tmp/code-agent/games/game.html',
        attempts: 0,
        phase: 'initial_repair',
        ...(noProgressTurns != null ? { noProgressTurns } : {}),
      },
      }),
    };
  }

  it('累加 noProgressTurns，未到上限不停闸', () => {
    const ctx = makeGuardCtx(0);
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, 'Read');
    expect(stopped).toBe(false);
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(1);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('连续 block 到 ARTIFACT_REPAIR_MAX_ATTEMPTS 触发 attempts-exhausted 硬停（修复 block 路径不喂计数器的死锁缺口）', () => {
    const ctx = makeGuardCtx(ARTIFACT_REPAIR_MAX_ATTEMPTS - 1);
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, 'List');
    expect(stopped).toBe(true);
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(ctx.control.forceFinalResponseReason).toBe(
      `${ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted']} ${ARTIFACT_REPAIR_MAX_ATTEMPTS}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} blocked tool calls`,
    );
    expect(ctx.control.forceFinalResponsePrompt).toContain('reached its attempt limit');
  });

  it('BC1 混合路径累积：unavailable-tool 与 block 共享 noProgressTurns，合计到上限即硬停（原 HIGH-1 回归升级）', () => {
    // 复现真实死锁：guard 锁了不可达 phantom 目标（2026-06-25 CSDN URL 案），模型
    // 交替「请求不可见工具」与「请求可用但被闸拦的工具」。旧实现两套计数各自不到顶
    // 且前者每回合被清零；统一计数器下无进展动作合计 4 次即硬停。
    const ctx = makeGuardCtx(0);
    // 前两次：unavailable-tool 路径（messageProcessorUnavailableTools 的计数口径）
    ctx.artifact.recordNoProgressTurn('Grep');
    ctx.artifact.recordNoProgressTurn('Task');
    // 后两次：block 路径
    expect(registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, 'Write')).toBe(false);
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, 'Write');
    expect(stopped).toBe(true);
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(ARTIFACT_REPAIR_MAX_ATTEMPTS);
    expect(ctx.control.forceFinalResponseReason?.startsWith(ARTIFACT_REPAIR_STOP_PREFIXES['attempts-exhausted'])).toBe(true);
  });

  it('BC1 进展清零续命：目标文件被成功改动（markTargetPatched）后计数归零，逃生门重新计', () => {
    const ctx = makeGuardCtx(ARTIFACT_REPAIR_MAX_ATTEMPTS - 1);
    ctx.artifact.markTargetPatched();
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(0);
    // 清零后再 block 一次不应硬停
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, ctx.artifact.repairGuard, 'Read');
    expect(stopped).toBe(false);
    expect(ctx.artifact.repairGuard.noProgressTurns).toBe(1);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });

  it('无 guard 时安全 no-op', () => {
    const ctx = makeCtx();
    const stopped = registerArtifactRepairBlockedToolTurn(ctx, undefined, 'Read');
    expect(stopped).toBe(false);
    expect(ctx.control.forceFinalResponseReason).toBeUndefined();
  });
});
