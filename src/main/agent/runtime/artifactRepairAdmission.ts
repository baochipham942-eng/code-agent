import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { validateGameArtifact } from './gameArtifactValidator';

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
