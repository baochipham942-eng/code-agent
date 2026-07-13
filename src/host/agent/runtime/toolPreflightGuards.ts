import type { ToolCall, ToolResult } from '../../../shared/contract';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { READ_ONLY_TOOLS } from '../../agent/loopTypes';
import { fileReadTracker } from '../../tools/fileReadTracker';
import type { ContextAssembly } from './contextAssembly';
import type { RuntimeContext } from './runtimeContext';
import { validateGameArtifact } from './gameArtifactValidator';

interface SearchCandidateRecord {
  path: string;
  sourceTool: string;
  discoveredAtMs: number;
}

interface SearchCandidateResult {
  success: boolean;
  metadata?: Record<string, unknown>;
}

const searchCandidatesBySession = new Map<string, Map<string, SearchCandidateRecord>>();

function sessionKey(ctx: Pick<RuntimeContext, 'sessionId' | 'agentId'>): string {
  return `${ctx.sessionId || 'session'}::${ctx.agentId || 'main'}`;
}

function normalizeFilePath(rawPath: string, workingDirectory: string): string {
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(workingDirectory, rawPath);
}

function isSearchDiscoveryTool(name: string): boolean {
  return name === 'Glob' || name === 'Grep' || name === 'ListDirectory';
}

function isSearchGuardedMutationTool(name: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write';
}

function getToolFilePath(toolCall: Pick<ToolCall, 'arguments'>, workingDirectory: string): string | null {
  const rawPath = toolCall.arguments?.file_path;
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  return normalizeFilePath(rawPath, workingDirectory);
}

function getCandidatePathsFromResult(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name'>,
  result: SearchCandidateResult,
): string[] {
  if (!result.success || !isSearchDiscoveryTool(toolCall.name)) return [];
  const metadata = result.metadata ?? {};
  const searchPath = typeof metadata.searchPath === 'string'
    ? metadata.searchPath
    : ctx.workingDirectory;
  const candidates = new Set<string>();

  if (Array.isArray(metadata.matches)) {
    for (const match of metadata.matches) {
      if (typeof match === 'string') {
        candidates.add(normalizeFilePath(match, searchPath));
      } else if (
        match &&
        typeof match === 'object' &&
        typeof (match as { file?: unknown }).file === 'string'
      ) {
        candidates.add(normalizeFilePath((match as { file: string }).file, searchPath));
      }
    }
  }

  if (Array.isArray(metadata.entries)) {
    for (const entry of metadata.entries) {
      if (!entry || typeof entry !== 'object') continue;
      const typed = entry as { path?: unknown; isDirectory?: unknown };
      if (typed.isDirectory === true || typeof typed.path !== 'string') continue;
      candidates.add(normalizeFilePath(typed.path, searchPath));
    }
  }

  return Array.from(candidates);
}

export function clearSearchCandidateIndexForTest(): void {
  searchCandidatesBySession.clear();
}

export function recordSearchCandidatesFromResult(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name'>,
  result: SearchCandidateResult,
): void {
  const paths = getCandidatePathsFromResult(ctx, toolCall, result);
  if (paths.length === 0) return;

  const key = sessionKey(ctx);
  let sessionCandidates = searchCandidatesBySession.get(key);
  if (!sessionCandidates) {
    sessionCandidates = new Map();
    searchCandidatesBySession.set(key, sessionCandidates);
  }

  const discoveredAtMs = Date.now();
  for (const candidatePath of paths) {
    sessionCandidates.set(candidatePath, {
      path: candidatePath,
      sourceTool: toolCall.name,
      discoveredAtMs,
    });
  }
}

export function getSearchToReadPreflightBlock(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): { error: string; code: 'READ_REQUIRED_AFTER_SEARCH'; metadata: Record<string, unknown> } | null {
  if (!isSearchGuardedMutationTool(toolCall.name)) return null;

  const targetPath = getToolFilePath(toolCall, ctx.workingDirectory);
  if (!targetPath) return null;

  if (toolCall.name === 'Write') {
    try {
      const stats = statSync(targetPath);
      if (!stats.isFile()) return null;
    } catch {
      // New files and missing targets are not constrained by search-to-read.
      return null;
    }
  } else if (!existsSync(targetPath)) {
    return null;
  }

  if (fileReadTracker.hasBeenRead(targetPath)) return null;

  const candidate = searchCandidatesBySession.get(sessionKey(ctx))?.get(targetPath);
  if (!candidate) return null;

  return {
    code: 'READ_REQUIRED_AFTER_SEARCH',
    error:
      `File ${targetPath} only appeared in ${candidate.sourceTool} search results. ` +
      'Read the exact file first to bind fresh evidence before Edit or overwrite Write.',
    metadata: {
      blocked: true,
      skipped: true,
      code: 'READ_REQUIRED_AFTER_SEARCH',
      path: targetPath,
      sourceTool: candidate.sourceTool,
      discoveredAtMs: candidate.discoveredAtMs,
    },
  };
}

export function activateForceFinalResponse(ctx: RuntimeContext, reason: string): void {
  if (ctx.control.forceFinalResponseReason) return;
  ctx.control.forceFinalResponse(reason, [
    '<force-final-response reason="read-loop-hard-limit">',
    'The runtime has stopped further tool use because the session entered a repeated read loop.',
    'Use only the file evidence already present in tool results and persistent context.',
    'Do not call any tool, do not switch to Bash/Python/Grep to re-read, and do not ask the user to repeat context.',
    'If exact evidence is missing, say which evidence is missing instead of inventing it.',
    'Produce the final answer now.',
    '</force-final-response>',
  ].join('\n'));
}

function isBashToolCallName(name: string): boolean {
  return name === 'bash' || name === 'Bash';
}

function activeSkillTargets(ctx: RuntimeContext): string[] {
  const invocation = ctx.turn.activeSkillInvocation;
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

  const skillName = ctx.turn.activeSkillInvocation?.skillName;
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
  if (ctx.artifact.repairGuard) {
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
  guard: NonNullable<RuntimeContext['artifact']['repairGuard']> | undefined,
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
    ctx.artifact.markValidationPassed(guard.targetFile);
    activateForceFinalResponse(ctx, `artifact repair target already passes validation after blocked ${guard.lastBlockedTool || 'source'} read`);
    return true;
  } catch {
    return false;
  }
}
