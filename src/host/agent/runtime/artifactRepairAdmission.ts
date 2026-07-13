import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { validateGameArtifact } from './gameArtifactValidator';
import { ARTIFACT_REPAIR_MAX_ATTEMPTS } from '../../../shared/constants/repair';
import { GAME_VALIDATION_TIMEOUTS } from '../../../shared/constants/game';

export type ArtifactRepairStopKind = 'unavailable-tool' | 'attempts-exhausted';

// Reason prefixes the UI error handler matches to surface a termination notice.
export const ARTIFACT_REPAIR_STOP_PREFIXES: Record<ArtifactRepairStopKind, string> = {
  'unavailable-tool': 'artifact repair unavailable tool repeated:',
  'attempts-exhausted': 'artifact repair attempts exhausted:',
};

/**
 * Route A loop guard: force-stop the current artifact repair turn instead of
 * spending another model request on a loop that is not making progress.
 * `detail` is the short context shown in the reason (e.g. blocked tool names,
 * or the attempt count).
 */
export function activateArtifactRepairAdmissionStop(
  ctx: RuntimeContext,
  targetFile: string,
  detail: string,
  kind: ArtifactRepairStopKind = 'unavailable-tool',
): void {
  ctx.control.forceFinalResponse(`${ARTIFACT_REPAIR_STOP_PREFIXES[kind]} ${detail}`, [
    '<force-final-response reason="artifact-repair-tool-admission">',
    `Artifact repair mode is active for ${targetFile}.`,
    kind === 'attempts-exhausted'
      ? `The repair loop reached its attempt limit (${detail}).`
      : `The model repeatedly requested unavailable tool(s): ${detail}.`,
    'Stop this attempt now instead of spending another model request on the same blocked action.',
    'Report that the target artifact still needs a mutation patch and that no target file change was applied.',
    '</force-final-response>',
  ].join('\n'));
  // 注:UI 端的 error event emit 在 forceFinalResponse 处理路径里(messageProcessor.ts forceFinalResponse 分支),
  // 必须在 final assistant message push 之后 emit,这样 useSessionLifecycleEffects 的 lastMessage 检查
  // 能命中 assistant 把 errorContent 合并进去显示。如果在这里 emit, lastMessage 还是上一轮的 tool 消息,UI 不显示。
}

/**
 * Block 路径循环断路器：可用但被 repair 闸拦下的工具（区别于 messageProcessorUnavailableTools
 * 的"工具不可用"路径）历史上不喂无进展计数器，导致 guard 锁死不可达 phantom 目标时
 * 每个工具被 block 但计数不动、无限死锁 (2026-06-25 dogfood：CSDN URL 被错种成目标)。
 * 现与 unavailable-tool 路径共用统一 noProgressTurns 计数器（仅目标被成功改动时清零，
 * 见 artifactState.markTargetPatched），连续 ARTIFACT_REPAIR_MAX_ATTEMPTS 次无进展即
 * 复用既有 attempts-exhausted 硬停。返回是否已触发硬停。
 */
export function registerArtifactRepairBlockedToolTurn(
  ctx: RuntimeContext,
  guard: NonNullable<RuntimeContext['artifact']['repairGuard']> | undefined,
  blockedTool: string,
): boolean {
  if (!guard?.targetFile) return false;
  const turns = ctx.artifact.recordNoProgressTurn(blockedTool);
  if (turns >= ARTIFACT_REPAIR_MAX_ATTEMPTS) {
    activateArtifactRepairAdmissionStop(
      ctx,
      guard.targetFile,
      `${turns}/${ARTIFACT_REPAIR_MAX_ATTEMPTS} blocked tool calls`,
      'attempts-exhausted',
    );
    return true;
  }
  return false;
}

export async function maybeClearCompletedArtifactRepairGuardBeforeAdmission(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  guard: NonNullable<RuntimeContext['artifact']['repairGuard']> | undefined,
  requestedNames: string,
): Promise<boolean> {
  if (!guard?.targetFile) return false;
  if (guard.phase === 'playability_repair') {
    contextAssembly.injectSystemMessage(
      [
        '<artifact-playability-repair-active>',
        `target file: ${guard.targetFile}`,
        'Static contract validation is not enough for this repair pass. Continue fixing the user-visible playability issue in the target artifact.',
        '</artifact-playability-repair-active>',
      ].join('\n'),
    );
    return false;
  }

  try {
    // 与 toolArtifactValidationLifecycle 的分级保持同一口径：goal 模式走重契约，
    // 普通聊天走 light + 可玩性冒烟。否则 light 产物在这里被 full 契约卡住，提前解锁永不触发。
    const fullContract = Boolean(ctx.goalMode?.isPending());
    const validation = await validateGameArtifact(guard.targetFile, {
      contractLevel: fullContract ? 'full' : 'light',
      runRuntimeSmoke: fullContract,
      runtimeSmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.RUNTIME_SMOKE_MS,
      requireRuntimeSmoke: fullContract,
      runBrowserVisualSmoke: fullContract,
      browserVisualSmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.BROWSER_VISUAL_SMOKE_MS,
      requireBrowserVisualSmoke: fullContract,
      allowBrowserVisualComputerFallback: false,
      runLightPlayabilitySmoke: !fullContract,
      lightPlayabilitySmokeTimeoutMs: GAME_VALIDATION_TIMEOUTS.LIGHT_PLAYABILITY_SMOKE_MS,
    });
    if (!validation.shouldValidate || !validation.passed) {
      return false;
    }

    contextAssembly.injectSystemMessage(
      [
        '<artifact-validation-passed kind="interactive_artifact">',
        'artifact repair guard revalidated the target before accepting another repair-mode tool call.',
        `requested tools: ${requestedNames}`,
        ...(ctx.goalMode?.isPending()
          ? [
              'The artifact already passed validation. Do not rewrite it again.',
              'Goal mode is still pending, so the next action must call attempt_completion with concise evidence.',
            ]
          : []),
        ...validation.checks.map((check, index) => `${index + 1}. ${check}`),
        'The repair guard has been cleared. Retry the user requested action with the full tool set if needed.',
        '</artifact-validation-passed>',
      ].join('\n'),
    );
    ctx.artifact.markValidationPassed(guard.targetFile);
    ctx.control.clearForceFinalResponse();
    return true;
  } catch {
    return false;
  }
}
