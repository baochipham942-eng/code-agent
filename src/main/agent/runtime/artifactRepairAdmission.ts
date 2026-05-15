import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { validateGameArtifact } from './gameArtifactValidator';

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
  ctx.forceFinalResponseReason = `${ARTIFACT_REPAIR_STOP_PREFIXES[kind]} ${detail}`;
  ctx.forceFinalResponsePrompt = [
    '<force-final-response reason="artifact-repair-tool-admission">',
    `Artifact repair mode is active for ${targetFile}.`,
    kind === 'attempts-exhausted'
      ? `The repair loop reached its attempt limit (${detail}).`
      : `The model repeatedly requested unavailable tool(s): ${detail}.`,
    'Stop this attempt now instead of spending another model request on the same blocked action.',
    'Report that the target artifact still needs a mutation patch and that no target file change was applied.',
    '</force-final-response>',
  ].join('\n');
  // 注:UI 端的 error event emit 在 forceFinalResponse 处理路径里(messageProcessor.ts forceFinalResponse 分支),
  // 必须在 final assistant message push 之后 emit,这样 useSessionLifecycleEffects 的 lastMessage 检查
  // 能命中 assistant 把 errorContent 合并进去显示。如果在这里 emit, lastMessage 还是上一轮的 tool 消息,UI 不显示。
}

export async function maybeClearCompletedArtifactRepairGuardBeforeAdmission(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  guard: NonNullable<RuntimeContext['artifactRepairGuard']> | undefined,
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
    const validation = await validateGameArtifact(guard.targetFile, {
      runRuntimeSmoke: true,
      runtimeSmokeTimeoutMs: 7000,
      runBrowserVisualSmoke: true,
      browserVisualSmokeTimeoutMs: 10000,
    });
    if (!validation.shouldValidate || !validation.passed) {
      return false;
    }

    contextAssembly.injectSystemMessage(
      [
        '<artifact-validation-passed kind="interactive_artifact">',
        'artifact repair guard revalidated the target before accepting another repair-mode tool call.',
        `requested tools: ${requestedNames}`,
        ...validation.checks.map((check, index) => `${index + 1}. ${check}`),
        'The repair guard has been cleared. Retry the user requested action with the full tool set if needed.',
        '</artifact-validation-passed>',
      ].join('\n'),
    );
    ctx.artifactRepairGuard = undefined;
    ctx.forceFinalResponseReason = undefined;
    ctx.forceFinalResponsePrompt = undefined;
    return true;
  } catch {
    return false;
  }
}
