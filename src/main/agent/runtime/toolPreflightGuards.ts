import type { ToolCall, ToolResult } from '../../../shared/contract';
import { READ_ONLY_TOOLS } from '../../agent/loopTypes';
import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { validateGameArtifact } from './gameArtifactValidator';

export function activateForceFinalResponse(ctx: RuntimeContext, reason: string): void {
  if (ctx.forceFinalResponseReason) return;
  ctx.forceFinalResponseReason = reason;
  ctx.forceFinalResponsePrompt = [
    '<force-final-response reason="read-loop-hard-limit">',
    'The runtime has stopped further tool use because the session entered a repeated read loop.',
    'Use only the file evidence already present in tool results and persistent context.',
    'Do not call any tool, do not switch to Bash/Python/Grep to re-read, and do not ask the user to repeat context.',
    'If exact evidence is missing, say which evidence is missing instead of inventing it.',
    'Produce the final answer now.',
    '</force-final-response>',
  ].join('\n');
}

function isBashToolCallName(name: string): boolean {
  return name === 'bash' || name === 'Bash';
}

function activeSkillTargets(ctx: RuntimeContext): string[] {
  const invocation = ctx.activeSkillInvocation;
  if (!invocation) return [];
  return Array.from(new Set([
    invocation.skillName,
    invocation.matchedText.replace(/^\//, ''),
    ...invocation.aliases,
  ]
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 2)));
}

function commandReferencesActiveSkill(ctx: RuntimeContext, command: string): boolean {
  const lowerCommand = command.toLowerCase();
  return activeSkillTargets(ctx).some((target) => lowerCommand.includes(target));
}

export function semanticProgressReasonForToolCall(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  result: Pick<ToolResult, 'success' | 'metadata'>,
): string | null {
  if (!result.success) return null;

  const skillName = ctx.activeSkillInvocation?.skillName;
  if (result.metadata?.isSkillActivation === true || toolCall.name === 'skill' || toolCall.name === 'Skill') {
    return `skill activation${skillName ? `: ${skillName}` : ''}`;
  }

  if (!skillName || !isBashToolCallName(toolCall.name)) return null;
  const command = typeof toolCall.arguments?.command === 'string'
    ? toolCall.arguments.command
    : '';
  if (!command) return null;
  if (ctx.antiPatternDetector.isReadOnlyShellCommand(command)) return null;
  if (!commandReferencesActiveSkill(ctx, command)) return null;
  return `active skill target command: ${skillName}`;
}

export function getReadOnlyPreflightWarning(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): { reserved: boolean; warning: string | null } {
  if (ctx.artifactRepairGuard) {
    // Artifact repair has its own target-file read budgets. Reserving the
    // generic read-loop counter here would consume those budgets before the
    // repair guard can make its narrower allow/block decision.
    return { reserved: false, warning: null };
  }

  if (READ_ONLY_TOOLS.includes(toolCall.name)) {
    if (typeof ctx.antiPatternDetector.preflightReadOnlyToolExecution !== 'function') {
      return { reserved: false, warning: null };
    }
    const preflight = ctx.antiPatternDetector.preflightReadOnlyToolExecution(toolCall.name);
    return { reserved: true, warning: preflight };
  }

  if ((toolCall.name === 'bash' || toolCall.name === 'Bash') && typeof toolCall.arguments?.command === 'string') {
    const command = toolCall.arguments.command as string;
    if (!ctx.antiPatternDetector.isReadOnlyShellCommand?.(command)) {
      return { reserved: false, warning: null };
    }
    if (typeof ctx.antiPatternDetector.preflightReadOnlyShellCommand !== 'function') {
      return { reserved: false, warning: null };
    }
    const preflight = ctx.antiPatternDetector.preflightReadOnlyShellCommand(command);
    return { reserved: true, warning: preflight };
  }

  return { reserved: false, warning: null };
}

export async function maybeFinishArtifactRepairIfAlreadyValid(
  ctx: RuntimeContext,
  contextAssembly: ContextAssembly,
  guard: NonNullable<RuntimeContext['artifactRepairGuard']> | undefined,
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
      requireRuntimeSmoke: true,
      runBrowserVisualSmoke: true,
      browserVisualSmokeTimeoutMs: 10000,
      requireBrowserVisualSmoke: true,
      allowBrowserVisualComputerFallback: false,
    });
    if (!validation.shouldValidate || !validation.passed) {
      return false;
    }

    contextAssembly.injectSystemMessage(
      [
        '<artifact-validation-passed kind="interactive_artifact">',
        'artifact repair guard revalidated the target after a blocked source read.',
        ...(ctx.goalMode?.isPending()
          ? [
              'The artifact already passed validation. Do not rewrite it again.',
              'Goal mode is still pending, so the next action must call attempt_completion with concise evidence.',
            ]
          : []),
        ...validation.checks.map((check, index) => `${index + 1}. ${check}`),
        '</artifact-validation-passed>',
      ].join('\n'),
    );
    ctx.artifactValidationPassedTargetFile = guard.targetFile;
    ctx.artifactRepairGuard = undefined;
    activateForceFinalResponse(ctx, `artifact repair target already passes validation after blocked ${guard.lastBlockedTool || 'source'} read`);
    return true;
  } catch {
    return false;
  }
}
