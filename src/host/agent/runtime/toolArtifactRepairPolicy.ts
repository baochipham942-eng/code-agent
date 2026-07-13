import type { ToolCall, ToolResult } from '../../../shared/contract';
import {
  ARTIFACT_REPAIR_MAX_ATTEMPTS,
  ARTIFACT_REPAIR_PATIENCE_ROUNDS,
  ARTIFACT_REPAIR_PATCH_RESISTANT_CODES,
  ARTIFACT_REPAIR_RESISTANT_STREAK,
} from '../../../shared/constants/repair';
import { GOAL_MODE } from '../../../shared/constants/agent';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { createHash } from 'crypto';
import type { RuntimeContext } from './runtimeContext';
import type { RepairInstructionStyle } from './scaffoldProfile';
import { isSameArtifactRepairPath } from './artifactRepairGuard';
import type { ArtifactRepairIssueCode, createArtifactRepairSpec } from './artifactRepairSpec';
import type { validateGameArtifact } from './gameArtifactValidator';
import type { BrowserVisualSmokeSummary } from './browser/types';
import { scopeGuardRegistry } from './repair/scopeGuards';
import { MonotonicityTracker } from './repair/monotonicityTracker';
import { fileReadTracker } from '../../tools/fileReadTracker';
import { extractReadFilePath } from './toolObservationSanitizers';

export function getModifiedFilePath(toolCall: Pick<ToolCall, 'arguments'>): string | null {
  const rawPath = toolCall.arguments?.file_path || toolCall.arguments?.path;
  return typeof rawPath === 'string' && rawPath.trim() ? rawPath : null;
}

export function isFileMutationTool(toolName: string): boolean {
  return (
    toolName === 'edit_file' ||
    toolName === 'Edit' ||
    toolName === 'write_file' ||
    toolName === 'Write' ||
    toolName === 'append_file' ||
    toolName === 'Append'
  );
}

export function getEditEntries(toolCall: Pick<ToolCall, 'arguments'>): Array<{ oldText: string; newText: string }> {
  const edits = toolCall.arguments?.edits;
  if (Array.isArray(edits)) {
    return edits
      .map((edit: unknown) => {
        const entry = edit && typeof edit === 'object'
          ? edit as { old_text?: unknown; new_text?: unknown }
          : {};
        return {
          oldText: typeof entry.old_text === 'string' ? entry.old_text : '',
          newText: typeof entry.new_text === 'string' ? entry.new_text : '',
        };
      })
      .filter((edit) => edit.oldText || edit.newText);
  }

  const oldText = toolCall.arguments?.old_text;
  const newText = toolCall.arguments?.new_text;
  if (typeof oldText === 'string' || typeof newText === 'string') {
    return [{
      oldText: typeof oldText === 'string' ? oldText : '',
      newText: typeof newText === 'string' ? newText : '',
    }];
  }

  return [];
}

function normalizePatchText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripCommentLikeLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:\/\/|\/\*|\*|<!--|#)/.test(line))
    .join('\n')
    .trim();
}

function getWriteLikeContent(toolCall: Pick<ToolCall, 'arguments'>): string | null {
  const content = toolCall.arguments?.content;
  return typeof content === 'string' ? content : null;
}

export function getArtifactRepairPatchFingerprint(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string | null {
  if (toolCall.name !== 'Edit' && toolCall.name !== 'edit_file') return null;
  const modifiedPath = getModifiedFilePath(toolCall);
  if (!modifiedPath) return null;
  const edits = getEditEntries(toolCall);
  if (edits.length === 0) return null;
  const payload = JSON.stringify({
    name: toolCall.name,
    path: modifiedPath,
    edits: edits.map((edit) => ({
      oldText: normalizePatchText(edit.oldText),
      newText: normalizePatchText(edit.newText),
    })),
  });
  return createHash('sha256').update(payload).digest('hex');
}

function getArtifactRepairPatchText(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string {
  const edits = getEditEntries(toolCall);
  if (edits.length > 0) {
    return edits.map((edit) => `${edit.oldText}\n${edit.newText}`).join('\n');
  }
  return getWriteLikeContent(toolCall) || '';
}

function isBalancedJavaScriptBlock(value: string): boolean {
  const braceStart = value.indexOf('{');
  if (braceStart < 0) return false;

  let depth = 0;
  let sawOpenBrace = false;
  let inString: '"' | "'" | '`' | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = braceStart; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      sawOpenBrace = true;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }

  return sawOpenBrace && depth === 0 && !inString && !lineComment && !blockComment;
}

function detectArtifactRepairIssueScopeMismatch(
  guard: NonNullable<RuntimeContext['artifact']['repairGuard']>,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): string | null {
  const issueCodes = guard.activeIssueCodes || [];
  if (issueCodes.length === 0) return null;
  const patchText = getArtifactRepairPatchText(toolCall);
  if (!patchText.trim()) return null;

  return scopeGuardRegistry.check(issueCodes, patchText);
}

function detectArtifactRepairContractStructureRisk(
  guard: NonNullable<RuntimeContext['artifact']['repairGuard']>,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): string | null {
  if (toolCall.name !== 'Edit' && toolCall.name !== 'edit_file') return null;
  const issueCodes = guard.activeIssueCodes || [];
  const contractSensitive =
    issueCodes.includes('coverage_without_runtime_evidence')
    || issueCodes.includes('shortcut_state_mutation')
    || issueCodes.includes('missing_test_contract')
    || issueCodes.includes('malformed_test_contract');
  if (!contractSensitive) return null;

  const edits = getEditEntries(toolCall);
  if (edits.length === 0) return null;

  for (const edit of edits) {
    const oldTouchesContract = /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=|runSmokeTest\s*\(/.test(edit.oldText);
    const newTouchesContract = /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=|runSmokeTest\s*\(/.test(edit.newText);
    if (!oldTouchesContract && !newTouchesContract) continue;

    const startsWithMethod = /^\s*runSmokeTest\s*\([^)]*\)\s*\{/.test(edit.newText);
    const methodOnlyReplacement = !/window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(edit.oldText);
    const closesWholeContract = /\n\s*};\s*(?:$|\n\s*window\.__(?:GAME|INTERACTIVE)_TEST__\s*=)/.test(edit.newText.trimEnd());
    const introducesAdditionalContractSurface =
      /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(edit.newText)
      || ((edit.newText.match(/(?:^|\n)\s*(?:start|reset|snapshot|step|runSmokeTest)\s*\(/g) || []).length > 1);
    if (methodOnlyReplacement && startsWithMethod && closesWholeContract && introducesAdditionalContractSurface) {
      return [
        'Patch is trying to replace a single contract method with a larger contract fragment that also closes the whole interactive contract.',
        'Either replace only the balanced `runSmokeTest() { ... },` method body, or replace the full `window.__GAME_TEST__ = { ... }` block in one Edit.',
      ].join(' ');
    }

    if (/window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/.test(edit.newText)) {
      if (!isBalancedJavaScriptBlock(edit.newText)) {
        return [
          'Patch would replace the interactive test contract with an unbalanced block.',
          'When editing `window.__GAME_TEST__` / `window.__INTERACTIVE_TEST__`, replace the full balanced object literal in one patch.',
        ].join(' ');
      }
      continue;
    }

    if (startsWithMethod && !isBalancedJavaScriptBlock(edit.newText)) {
      return [
        'Patch would replace only a fragment of `runSmokeTest()` and would leave the interactive contract structurally incomplete.',
        'Use a complete balanced `runSmokeTest() { ... }` method replacement, or replace the full `window.__GAME_TEST__ = { ... }` block in one Edit.',
      ].join(' ');
    }
  }

  return null;
}

// Route A: the ranged-read scope/window machinery is gone — the target artifact
// is fully readable during repair, so there is no need to compute "relevant
// windows" or soft-block unrelated ranged reads.

function isWriteTool(toolName: string): boolean {
  return toolName === 'write_file' || toolName === 'Write';
}

function isPlaceholderLikeArtifactContent(content: string): boolean {
  const normalized = normalizePatchText(stripCommentLikeLines(content) || content);
  return /^(?:dummy|test|todo|placeholder|place_holder|read_needed|placeholder_read_needed|tbd|待补|占位)$/i.test(normalized);
}

function containsArtifactPlaceholderMarker(value: string): boolean {
  return (
    /\b(?:probe_[a-z0-9_]*|placeholder_[a-z0-9_]+|place_holder_[a-z0-9_]+|placeholder_read_needed|read_needed|tbd)\b/i.test(value) ||
    /(?:\/\/|\/\*|<!--)\s*(?:probe|placeholder|place_holder|read_needed|tbd)\b/i.test(value)
  );
}

function isProbeLikeArtifactEdit(toolCall: Pick<ToolCall, 'arguments'>): boolean {
  const edits = getEditEntries(toolCall);
  if (edits.length === 0) return false;
  return edits.every((edit) => {
    const combined = `${edit.oldText}\n${edit.newText}`;
    if (/\bPROBE_[A-Z0-9_]*\b/.test(combined)) return true;
    return /(?:\/\*\s*PROBE\b|\bPROBE\b\s*\*\/|<!--\s*PROBE\b)/i.test(combined);
  });
}

function looksLikeCompleteHtmlArtifact(content: string): boolean {
  return /<html\b/i.test(content) && /<\/html\s*>/i.test(content);
}

function exposesInteractiveArtifactContract(content: string): boolean {
  return /window\.__(?:GAME|INTERACTIVE)_TEST__\s*=/i.test(content);
}

function detectArtifactRepairNoOpPatch(toolCall: Pick<ToolCall, 'name' | 'arguments'>): string | null {
  if (toolCall.name === 'Edit' || toolCall.name === 'edit_file') {
    const edits = getEditEntries(toolCall);
    if (edits.length === 0) return 'Edit did not include concrete replacement text.';

    const allNoChange = edits.every((edit) => normalizePatchText(edit.oldText) === normalizePatchText(edit.newText));
    if (allNoChange) return 'Edit does not change the artifact.';

    const allDummy = edits.every((edit) =>
      /^(?:dummy|test|todo|placeholder)$/i.test(normalizePatchText(edit.oldText)) &&
      /^(?:dummy|test|todo|placeholder)$/i.test(normalizePatchText(edit.newText)),
    );
    if (allDummy) return 'Edit only contains placeholder text.';

    const replacesWithPlaceholder = edits.some((edit) => isPlaceholderLikeArtifactContent(edit.newText));
    if (replacesWithPlaceholder) return 'Edit would replace artifact content with placeholder text.';

    if (isProbeLikeArtifactEdit(toolCall)) {
      return 'Edit is being used as a source probe instead of a repair patch.';
    }

    const introducesPlaceholderMarker = edits.some((edit) =>
      containsArtifactPlaceholderMarker(edit.newText) && !containsArtifactPlaceholderMarker(edit.oldText),
    );
    if (introducesPlaceholderMarker) {
      return 'Edit introduces placeholder or probe markers instead of repaired gameplay or contract logic.';
    }

    const introducesDiagnosticLogging = edits.some((edit) =>
      /\b(?:console\.(?:log|debug|info|warn|error)|debugger)\b/.test(edit.newText)
      && !/\b(?:console\.(?:log|debug|info|warn|error)|debugger)\b/.test(edit.oldText),
    );
    if (introducesDiagnosticLogging) {
      return 'Edit adds diagnostic logging or debugger statements instead of repairing gameplay or test-contract behavior.';
    }

    const onlyCommentAdjunct = edits.every((edit) => {
      const oldBody = stripCommentLikeLines(edit.oldText);
      const newBody = stripCommentLikeLines(edit.newText);
      return (
        oldBody !== '' &&
        newBody !== '' &&
        normalizePatchText(oldBody) === normalizePatchText(newBody) &&
        normalizePatchText(edit.oldText) !== normalizePatchText(edit.newText)
      );
    });
    if (onlyCommentAdjunct) return 'Edit only adds or changes comments around existing code, not gameplay or test behavior.';

    const onlyCommentOrBanner = edits.every((edit) => {
      const oldBody = stripCommentLikeLines(edit.oldText);
      const newBody = stripCommentLikeLines(edit.newText);
      return oldBody === '' && newBody === '';
    });
    if (onlyCommentOrBanner) return 'Edit only changes comments or banner text, not gameplay or test behavior.';
  }

  if (isWriteTool(toolCall.name) || isAppendTool(toolCall.name)) {
    const content = getWriteLikeContent(toolCall);
    if (typeof content !== 'string' || content.trim() === '') {
      return `${toolCall.name} did not include artifact content.`;
    }
    if (isPlaceholderLikeArtifactContent(content)) {
      return `${toolCall.name} would write placeholder text instead of a repaired artifact.`;
    }
    if (isWriteTool(toolCall.name) && !looksLikeCompleteHtmlArtifact(content)) {
      return 'Write would replace the target artifact with incomplete HTML. Use Edit for a local patch, or Write a complete HTML document.';
    }
    if (isWriteTool(toolCall.name) && !exposesInteractiveArtifactContract(content)) {
      return 'Write would replace the target artifact without the interactive test contract. Use Edit for a local patch, or Write a complete interactive artifact.';
    }
  }

  return null;
}

export function isArtifactRepairEditAnchorFailure(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  result: Pick<ToolResult, 'success' | 'error'>,
): boolean {
  const guard = ctx.artifact.repairGuard;
  if (!guard || result.success !== false) return false;
  if (toolCall.name !== 'Edit' && toolCall.name !== 'edit_file') return false;

  const modifiedPath = getModifiedFilePath(toolCall);
  if (!modifiedPath || !isSameArtifactRepairPath(ctx, modifiedPath, guard.targetFile)) return false;

  const error = result.error || '';
  return /Edit #\d+\/\d+ failed: (?:found \d+ occurrences|text not found)|Use replace_all: true or provide more context|AMBIGUOUS_MATCH|NOT_FOUND/i.test(error);
}

export function buildArtifactRepairEditAnchorFailurePrompt(
  targetFile: string,
  error: string | undefined,
  issueCodes: string[] = [],
): string {
  const scopeHints: string[] = [];
  const allowFullRewrite = issueCodes.some((code) =>
    code === 'missing_gameplay_mechanics'
    || code === 'gameplay_mechanics_without_runtime_evidence'
    || code === 'ability_gate_without_reachability'
  );
  const duplicateContractHints: string[] = [
    'If the failing anchor appears multiple times, replace a larger unique enclosing region instead of retrying the inner snippet.',
    'For game contract repairs, replace the enclosing `window.__GAME_TEST__ = { ... }` block or a larger unique region that stops before the autotest footer.',
  ];
  if (
    issueCodes.includes('coverage_without_runtime_evidence')
    || issueCodes.includes('shortcut_state_mutation')
  ) {
    scopeHints.push(
      'For coverage failures, anchor the replacement on the contract section, for example include `window.__GAME_TEST__ = {` and the specific `runSmokeTest() {` block in old_text.',
    );
    duplicateContractHints.push(
      'Do not target inner `step(input, frames)` or `runSmokeTest()` snippets directly when they may appear more than once.',
      'When duplicate contract tails exist, replace a region that runs through the duplicated tail and stops before the autotest footer.',
    );
  }
  if (
    issueCodes.includes('missing_controls_metadata')
    || issueCodes.includes('missing_coverage_metadata')
    || issueCodes.includes('missing_reachability_metadata')
    || issueCodes.includes('missing_quality_metadata')
  ) {
    scopeHints.push(
      'For metadata failures, add or update a literal `window.__GAME_META__ = { ... }` near the test contract with controls, authored levels/scenarios, reachability/progressPlan, and qualityPlan.',
    );
  }
  return [
    '<artifact-repair-edit-anchor-failed>',
    `Artifact repair mode is active for ${targetFile}.`,
    `The previous Edit failed because its old_text anchors were not exact enough: ${error || 'edit anchor failed'}`,
    'Do not repeat the same Edit shape or short old_text anchors.',
    ...scopeHints,
    ...duplicateContractHints,
    allowFullRewrite
      ? 'Because this failure spans platformer gameplay metadata, live runtime mechanics, and smoke evidence, a complete Write is allowed if a balanced targeted Edit would be brittle. The Write must be one complete HTML document with the live game and test contract intact.'
      : 'Use a more specific Edit with surrounding context from the target contract/metadata block. If you need a lookup, use one ranged Read with offset/limit around the existing contract block.',
    allowFullRewrite
      ? 'Do not emit a partial fragment. If using Write, replace the full artifact with a playable platformer that proves stomp, bump block, ability acquisition, gated route unlock, and comboChallenge through before/after snapshot evidence.'
      : 'Do not use Write to replace the complete target HTML just because an Edit anchor was ambiguous.',
    'The replacement must preserve the playable game and fix __GAME_TEST__/__INTERACTIVE_TEST__ using real input-driven snapshot changes.',
    '</artifact-repair-edit-anchor-failed>',
  ].join('\n');
}

function buildArtifactRepairRepeatedPatchPrompt(targetFile: string): string {
  return [
    '<artifact-repair-repeated-failed-patch>',
    `Artifact repair mode is active for ${targetFile}.`,
    'The current Edit repeats the same target-file patch that already failed artifact validation and was rolled back.',
    'Do not retry the same replacement again.',
    'Switch strategy now: replace a larger unique contract/metadata region instead of retrying a short inner snippet. Anchor on `window.__GAME_TEST__ = {` or the full contract block before the autotest footer.',
    'The repair must fix the live game/test contract with input-driven snapshot changes instead of a direct state grant or placeholder probe.',
    '</artifact-repair-repeated-failed-patch>',
  ].join('\n');
}

function formatBrowserVisualEvidenceForRepair(browserVisualSmoke?: BrowserVisualSmokeSummary): string[] {
  if (!browserVisualSmoke) return [];
  const diagnostics = browserVisualSmoke.diagnostics;
  const lines = [
    'Frontend browser validation evidence:',
    `- attempted=${browserVisualSmoke.attempted}, passed=${browserVisualSmoke.passed}${browserVisualSmoke.skipped ? ', skipped=true' : ''}`,
    ...browserVisualSmoke.checks.slice(0, 4).map((check) => `- ${check}`),
    ...browserVisualSmoke.failures.slice(0, 4).map((failure) => `- ${failure}`),
  ];

  if (diagnostics) {
    lines.push(
      `- title=${diagnostics.title || '(empty)'}, metaPresent=${diagnostics.metaPresent === true}, testPresent=${diagnostics.testPresent === true}`,
      `- canvasCount=${diagnostics.canvasCount ?? 0}, nonblankCanvasCount=${diagnostics.nonblankCanvasCount ?? 0}, visibleElements=${diagnostics.visibleElements ?? 0}`,
    );
    if (diagnostics.computerUseFallback) {
      lines.push(
        `- computerUseFallback screenshot=${diagnostics.computerUseFallback.screenshotPath || '(none)'}, frontmost=${diagnostics.computerUseFallback.frontmostApp || '(unknown)'}`,
      );
    }
  }

  return lines;
}

function isPlatformerStructuralGameplayRepair(issueCodes: readonly string[] = []): boolean {
  return issueCodes.some((code) =>
    code === 'missing_gameplay_mechanics'
    || code === 'gameplay_mechanics_without_runtime_evidence'
    || code === 'ability_gate_without_reachability',
  );
}

export function enforceArtifactRepairRepeatedPatchGuard(ctx: RuntimeContext, toolCall: ToolCall): string | null {
  const guard = ctx.artifact.repairGuard;
  if (!guard?.lastFailedPatchFingerprint) return null;
  if (toolCall.name !== 'Edit' && toolCall.name !== 'edit_file') return null;

  const modifiedPath = getModifiedFilePath(toolCall);
  if (!modifiedPath || !isSameArtifactRepairPath(ctx, modifiedPath, guard.targetFile)) return null;

  const fingerprint = getArtifactRepairPatchFingerprint(toolCall);
  if (!fingerprint || fingerprint !== guard.lastFailedPatchFingerprint) return null;

  return buildArtifactRepairRepeatedPatchPrompt(guard.targetFile);
}

export function shouldValidateModifiedArtifact(toolCall: Pick<ToolCall, 'name' | 'arguments'>): boolean {
  return isFileMutationTool(toolCall.name);
}

export function isAppendTool(toolName: string): boolean {
  return toolName === 'append_file' || toolName === 'Append';
}

export function completedAppendWithoutFinal(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
  validation: { isComplete: boolean; shouldValidate: boolean },
): boolean {
  return isAppendTool(toolCall.name) && toolCall.arguments?.final !== true && validation.shouldValidate && validation.isComplete;
}

export function buildRepairTargetLostValidationFailure(
  validation: Awaited<ReturnType<typeof validateGameArtifact>>,
): Awaited<ReturnType<typeof validateGameArtifact>> {
  return {
    ...validation,
    shouldValidate: true,
    passed: false,
    failures: [
      'Repair target no longer exposes the interactive artifact contract after the patch. Restore the self-contained artifact instead of replacing it with placeholder or non-interactive content.',
    ],
  };
}

export type ArtifactRepairRollbackSnapshot = {
  filePath: string;
  content: string;
};

export function captureArtifactRepairRollbackSnapshot(
  ctx: RuntimeContext,
  toolCall: Pick<ToolCall, 'name' | 'arguments'>,
): ArtifactRepairRollbackSnapshot | null {
  const guard = ctx.artifact.repairGuard;
  if (!guard || !isFileMutationTool(toolCall.name)) return null;

  const modifiedPath = getModifiedFilePath(toolCall);
  if (!modifiedPath || !isSameArtifactRepairPath(ctx, modifiedPath, guard.targetFile)) return null;

  const absolutePath = isAbsolute(modifiedPath)
    ? modifiedPath
    : resolve(ctx.workingDirectory || process.cwd(), modifiedPath);
  if (!existsSync(absolutePath)) return null;

  try {
    return {
      filePath: absolutePath,
      content: readFileSync(absolutePath, 'utf-8'),
    };
  } catch {
    return null;
  }
}

export function restoreArtifactRepairRollbackSnapshot(
  snapshot: ArtifactRepairRollbackSnapshot | null,
  absolutePath: string,
): boolean {
  if (snapshot?.filePath !== absolutePath) return false;
  try {
    writeFileSync(snapshot.filePath, snapshot.content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export async function refreshArtifactRepairReadStateAfterRollback(
  snapshot: ArtifactRepairRollbackSnapshot | null,
  absolutePath: string,
): Promise<void> {
  if (snapshot?.filePath !== absolutePath) return;
  await fileReadTracker.recordReadWithStats(absolutePath);
}

export type GameArtifactValidationResult = Awaited<ReturnType<typeof validateGameArtifact>>;
export type ArtifactRepairSpecResult = ReturnType<typeof createArtifactRepairSpec>;

function countArtifactRepairProblems(
  validation: GameArtifactValidationResult,
  repairSpec: ArtifactRepairSpecResult | null,
): number {
  const issueCount = Array.isArray(repairSpec?.issues) ? repairSpec.issues.length : 0;
  if (issueCount > 0) return issueCount;
  return Array.isArray(validation.failures) ? validation.failures.length : 0;
}

export function shouldKeepImprovedFailedArtifactPatch(options: {
  currentValidation: GameArtifactValidationResult;
  currentRepairSpec: ArtifactRepairSpecResult;
  rollbackValidation: GameArtifactValidationResult | null;
  rollbackRepairSpec: ArtifactRepairSpecResult | null;
  repairTargetLostValidation: boolean;
}): boolean {
  if (options.repairTargetLostValidation) return false;
  if (!options.rollbackValidation?.shouldValidate || options.rollbackValidation.passed) return false;
  if (!options.currentValidation.shouldValidate || options.currentValidation.passed) return false;

  const currentProblems = countArtifactRepairProblems(options.currentValidation, options.currentRepairSpec);
  const rollbackProblems = countArtifactRepairProblems(options.rollbackValidation, options.rollbackRepairSpec);
  if (currentProblems <= 0 || rollbackProblems <= 0) return false;

  const tracker = new MonotonicityTracker();
  tracker.recordRound(0, -rollbackProblems, options.rollbackValidation.failures);
  const verdict = tracker.recordRound(1, -currentProblems, options.currentValidation.failures);
  return verdict.verdict === 'improved' && verdict.keep;
}

const ARTIFACT_REPAIR_VERIFY_COMMAND_PATTERN =
  /\b(validate|validator|vitest|jest|mocha|playwright|test|check|lint|tsc|typecheck|build|compile|npm\s+(?:run\s+)?(?:test|check|lint|typecheck|build|compile)|pnpm\s+(?:run\s+)?(?:test|check|lint|typecheck|build|compile)|yarn\s+(?:run\s+)?(?:test|check|lint|typecheck|build|compile))\b/i;

function isArtifactRepairAllowedBash(command: string): boolean {
  return ARTIFACT_REPAIR_VERIFY_COMMAND_PATTERN.test(command) && !isArtifactRepairBashSourceRead(command);
}

function isArtifactRepairBashSourceRead(command: string): boolean {
  const explicitReaderPattern =
    /\b(cat|less|more|sed|awk|nl|bat)\b|\bpython3?\b[\s\S]*\b(open|read_text|readlines|Path\()/i;
  if (explicitReaderPattern.test(command)) return true;

  const headTailFilePattern =
    /\b(head|tail)\b(?:\s+-n\s+\d+|\s+-\d+)?\s+(?:"[^"]+\.(?:ts|tsx|js|jsx|mjs|cjs|html?|css|json|md|txt)"|'[^']+\.(?:ts|tsx|js|jsx|mjs|cjs|html?|css|json|md|txt)'|[^\s|;&]+\.(?:ts|tsx|js|jsx|mjs|cjs|html?|css|json|md|txt))/i;
  if (headTailFilePattern.test(command)) return true;

  return /\b(rg|grep)\b[\s\S]*[^\s|;&]+\.(?:ts|tsx|js|jsx|mjs|cjs|html?|css|json|md|txt)/i.test(command);
}

export function enforceArtifactRepairGuard(ctx: RuntimeContext, toolCall: ToolCall): string | null {
  const guard = ctx.artifact.repairGuard;
  if (!guard) return null;

  const readPath = extractReadFilePath(toolCall);
  if (readPath) {
    if (isSameArtifactRepairPath(ctx, readPath, guard.targetFile)) {
      // Route A: the target artifact is always fully readable during repair —
      // no read budgets, no ranged-read scope gating. The model needs the full
      // file to anchor an Edit or to do a complete Write.
      return null;
    }
    return [
      `Artifact repair mode is active for ${guard.targetFile}.`,
      'Read is limited to the target artifact file during repair.',
      'Use Edit, Append, or Write on the target file, then run validation.',
    ].join(' ');
  }

  if (isFileMutationTool(toolCall.name)) {
    const modifiedPath = getModifiedFilePath(toolCall);
    if (modifiedPath && isSameArtifactRepairPath(ctx, modifiedPath, guard.targetFile)) {
      // Route A: Write is a first-class repair action. Edit/Append/Write on the
      // target file are all allowed — the checks below only return soft guidance
      // text for genuinely broken patches; they no longer escalate guard state.
      const noOpReason = detectArtifactRepairNoOpPatch(toolCall);
      if (noOpReason) {
        return [
          `Artifact repair mode is active for ${guard.targetFile}.`,
          noOpReason,
          'Patch must change gameplay state, __GAME_TEST__/__INTERACTIVE_TEST__, progressPlan, snapshot, step, reset, or runSmokeTest.',
          'If a focused Edit cannot anchor cleanly, rewrite the full artifact with Write instead.',
        ].join(' ');
      }
      const issueScopeMismatch = detectArtifactRepairIssueScopeMismatch(guard, toolCall);
      if (issueScopeMismatch) {
        return [
          `Artifact repair mode is active for ${guard.targetFile}.`,
          issueScopeMismatch,
          'Use the validation failure summary already in context and patch the failing contract area directly.',
        ].join(' ');
      }
      const contractStructureRisk = detectArtifactRepairContractStructureRisk(guard, toolCall);
      if (contractStructureRisk) {
        return [
          `Artifact repair mode is active for ${guard.targetFile}.`,
          contractStructureRisk,
          'Do not patch a contract prefix or inner tail that relies on omitted closing braces.',
        ].join(' ');
      }
      return null;
    }
    return [
      `Artifact repair mode is active for ${guard.targetFile}.`,
      'File mutation is limited to the target artifact file during repair.',
      'Use Edit or Append on the target file, then run validation.',
    ].join(' ');
  }

  if (toolCall.name === 'bash' || toolCall.name === 'Bash') {
    const command = toolCall.arguments?.command;
    if (!guard.patched) {
      return [
        `Artifact repair mode is active for ${guard.targetFile}.`,
        'Bash verification is only available after you patch the target artifact.',
        'Use Edit or Append on the target file first.',
      ].join(' ');
    }
    if (typeof command === 'string' && isArtifactRepairAllowedBash(command)) {
      return null;
    }
    return [
      `Artifact repair mode is active for ${guard.targetFile}.`,
      'Bash is limited to validator, test, typecheck, lint, build, or compile-style verification commands.',
      'Bash verification is only available after you patch the target artifact.',
    ].join(' ');
  }

  return [
    `Artifact repair mode is active for ${guard.targetFile}.`,
    `${toolCall.name} is blocked during artifact repair because the failure summary already defines the repair scope.`,
    'Allowed actions are target-file Read/Edit/Append first, then validator, test, typecheck, lint, build, or compile Bash commands after patching.',
  ].join(' ');
}

export function buildArtifactRepairRecoveryPrompt(
  targetFile: string,
  issueCodes: readonly string[] = [],
): string {
  const platformerStructuralRepair = isPlatformerStructuralGameplayRepair(issueCodes);
  return [
    '<artifact-repair-recovery>',
    `You are already inside artifact repair mode for ${targetFile}.`,
    'Do not read validator/runtime source files again.',
    'Do not use Grep, Glob, ToolSearch, Task, or any source-exploration tool.',
    'Use only the target HTML file plus the validator failure summary already in context.',
    'You may Read the target HTML file as needed for exact anchors before patching.',
    platformerStructuralRepair
      ? 'Your next action must be Edit, Append, or a complete Write on the target HTML file now. Because this is a platformer gameplay-structure repair, a complete Write is preferred when the existing level layout, collision code, and smoke path are coupled.'
      : 'Your next action must be Edit, Append, or a complete Write on the target HTML file now. Prefer one complete Write of the whole self-contained HTML; a focused Edit/Append is fine when it anchors cleanly. Do not make comment-only, version-only, dummy, or placeholder edits.',
    'If the active issue is malformed_test_contract, do not patch an inner method. Replace the full balanced `window.__GAME_TEST__ = { ... }` / `window.__INTERACTIVE_TEST__ = { ... }` region and remove any duplicate orphaned contract methods that follow it.',
    ...(platformerStructuralRepair
      ? [
          'For platformer gameplay repair, fix the live mechanic path and the smoke evidence together: stomp must defeat an enemy and bounce/vy, bump must change block/reward state, ability must change player abilities, and the gate/route must become reachable after the ability or reward.',
          'Do not only rewrite runSmokeTest coverage. Move or reshape block/enemy/gate layout, collision bounds, or deterministic control path until before/after snapshot evidence proves the mechanic.',
        ]
      : []),
    'A valid repair must change gameplay state, __GAME_TEST__/__INTERACTIVE_TEST__, progressPlan, snapshot, step, reset, runSmokeTest, or authored level progression.',
    'Keep start/reset/step/snapshot/runSmokeTest wired to the same live game state as the playable loop; do not add placeholder markers, direct grants, or evidence-only coverage.',
    'For coverage_without_runtime_evidence, remove coverage branches based on object existence, level loading, enemy/spike/item presence, or registered mechanics; only add coverage after before/after snapshot values change through step(input, frames).',
    'After patching, run the validator command and inspect only its result.',
    '</artifact-repair-recovery>',
  ].join('\n');
}

export type ArtifactRepairPhase = 'baseline_repair' | 'targeted_repair' | 'read_then_patch' | 'playability_repair' | 'fresh_rewrite';

export type ArtifactValidationFailureState = {
  attempts: number;
  phase: ArtifactRepairPhase;
  /** 历史最少失败项数（patience 基准，越小越好） */
  bestFailureCount?: number;
  /** 连续未刷新最佳成绩的轮数（patience 计数器） */
  roundsSinceBest?: number;
  /** 各失败码连续存活轮数（补丁抗性动态信号） */
  failureCodeStreaks?: Record<string, number>;
  /** 干净上下文重写是否已用掉（每目标一次机会） */
  rewriteAttempted?: boolean;
  /** goal 模式降级放行待办：由策略裁决置位，conversationRuntime 闸3 消费 */
  degradedReleasePending?: string;
};

type RuntimeContextWithArtifactFailures = RuntimeContext & {
  artifactValidationFailures?: Map<string, ArtifactValidationFailureState>;
};

export function getArtifactValidationFailureMap(ctx: RuntimeContext): Map<string, ArtifactValidationFailureState> {
  const runtimeCtx = ctx as RuntimeContextWithArtifactFailures;
  if (!runtimeCtx.artifactValidationFailures) {
    runtimeCtx.artifactValidationFailures = new Map();
  }
  return runtimeCtx.artifactValidationFailures;
}

export type ArtifactRepairStrategyDecision =
  | { kind: 'continue_repair' }
  | { kind: 'switch_rewrite'; reason: string; resistantCodes: string[] }
  | { kind: 'degraded_release'; reason: string };

/**
 * 修复策略裁决（patience + 双信号，maka 借鉴批 WP3）。每轮验收失败后调用：
 * 1. 刷新 patience 状态（历史最少失败项 / 连续未刷新轮数 / 失败码存活 streak）
 * 2. 出现存活 ≥RESISTANT_STREAK 轮的补丁抗性失败码，或 patience 耗尽
 *    → 切一次干净上下文重写（每目标一次机会）
 * 3. 重写机会已用仍不收敛 → goal 模式降级放行（最佳版本已由 monotonicity
 *    保护落盘），非 goal 维持既有 attempts 硬停。
 */
export function decideArtifactRepairStrategy(options: {
  state: ArtifactValidationFailureState;
  failureCount: number;
  issueCodes: string[];
  goalPending: boolean;
}): ArtifactRepairStrategyDecision {
  const { state, failureCount, issueCodes, goalPending } = options;

  // 刷新失败码存活 streak：本轮还在的 +1，消失的清除
  const previousStreaks = state.failureCodeStreaks ?? {};
  const streaks: Record<string, number> = {};
  for (const code of new Set(issueCodes)) {
    streaks[code] = (previousStreaks[code] ?? 0) + 1;
  }
  state.failureCodeStreaks = streaks;

  // 刷新 patience：失败项比历史最佳更少 = 有净进展
  if (state.bestFailureCount === undefined || failureCount < state.bestFailureCount) {
    state.bestFailureCount = failureCount;
    state.roundsSinceBest = 0;
  } else {
    state.roundsSinceBest = (state.roundsSinceBest ?? 0) + 1;
  }

  const resistantSet = new Set<string>(ARTIFACT_REPAIR_PATCH_RESISTANT_CODES);
  const resistantCodes = Object.entries(streaks)
    .filter(([code, streak]) => resistantSet.has(code) && streak >= ARTIFACT_REPAIR_RESISTANT_STREAK)
    .map(([code]) => code);
  const patienceExhausted = (state.roundsSinceBest ?? 0) >= ARTIFACT_REPAIR_PATIENCE_ROUNDS;

  if (!resistantCodes.length && !patienceExhausted) {
    return { kind: 'continue_repair' };
  }

  if (!state.rewriteAttempted) {
    const reason = resistantCodes.length
      ? `失败码 ${resistantCodes.join('/')} 连续 ${ARTIFACT_REPAIR_RESISTANT_STREAK}+ 轮修不动（补丁抗性）`
      : `连续 ${ARTIFACT_REPAIR_PATIENCE_ROUNDS} 轮未刷新最佳成绩（patience 耗尽）`;
    return { kind: 'switch_rewrite', reason, resistantCodes };
  }

  if (goalPending) {
    const reason = `修复与一次干净重写均未收敛（最佳成绩 ${state.bestFailureCount} 项失败），按最佳版本降级放行`;
    return { kind: 'degraded_release', reason };
  }
  return { kind: 'continue_repair' };
}

/**
 * goal 模式降级放行判据（供 conversationRuntime 闸3 消费）：
 * 策略裁决置位 degradedReleasePending，或 attempts 达 2×上限兜底
 * （admission stop 只 force 当轮，goal 重进 repair 会无限涨，dogfood 实测 6/4）。
 * 语义为 markMetDegraded 诚实降级交付（最佳版本已落盘），非 aborted——
 * aborted 只留给"没有任何可用产物"的情况。
 */
export function getGoalArtifactRepairReleaseReason(ctx: RuntimeContext): string | null {
  const failureMap = getArtifactValidationFailureMap(ctx);
  const backstopThreshold = ARTIFACT_REPAIR_MAX_ATTEMPTS * GOAL_MODE.ARTIFACT_REPAIR_GOAL_ABORT_MULTIPLIER;
  for (const [targetFile, failure] of failureMap) {
    if (failure.degradedReleasePending) {
      return `${failure.degradedReleasePending}；目标文件 ${targetFile}`;
    }
    if (failure.attempts >= backstopThreshold) {
      return `artifact 修复 ${failure.attempts} 次（${GOAL_MODE.ARTIFACT_REPAIR_GOAL_ABORT_MULTIPLIER}×上限兜底）仍未通过验收，按最佳版本降级放行；目标文件 ${targetFile}`;
    }
  }
  return null;
}

export function buildArtifactRepairInstruction(
  absolutePath: string,
  failures: string[],
  attempts: number,
  phase: ArtifactRepairPhase,
  repairSpecBlock: string,
  browserVisualSmoke?: BrowserVisualSmokeSummary,
  issueCodes: readonly ArtifactRepairIssueCode[] = [],
  style: RepairInstructionStyle = 'full',
): string {
  const issueSummary = failures
    .map((failure, index) => `${index + 1}. ${failure}`)
    .join('\n');
  const phaseLine = `repair phase: ${phase}`;
  const attemptsLine = `attempts: ${attempts}`;
  const platformerStructuralRepair = isPlatformerStructuralGameplayRepair(issueCodes);

  // compact 版（B7 scaffold profile，strong 档）：失败项清单 + 一行修复指令，
  // 删长 XML 说教（repairSpecBlock 仍随 toolResult.error 返回，模型不丢机器可读 spec）。
  // fresh_rewrite 优先分支必须先判，与下方 full 版同构——重写轮措辞与补丁阶梯相反，
  // 否则和"不要重写整页"类指令自相矛盾（既有坑，见 full 版注释）。
  if (style === 'compact') {
    const header = [
      '<artifact-validation-failed kind="interactive_artifact">',
      attemptsLine,
      phaseLine,
      `target file: ${absolutePath}`,
    ];
    if (phase === 'fresh_rewrite') {
      return [
        ...header,
        '补丁式修复已停用，本轮执行唯一一次干净重写。',
        issueSummary,
        ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
        '先 Read 目标文件（磁盘上是历史最佳版本，作参照），再用一次完整 Write 输出全新实现，一次性修复上面全部失败项且不得回退已通过项；不要做局部 Edit/Append。',
        '</artifact-validation-failed>',
      ].join('\n');
    }
    return [
      ...header,
      issueSummary,
      ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
      '直接对目标文件做最小修复，逐项补齐上面失败项，修完运行 validator 验证。',
      '</artifact-validation-failed>',
    ].join('\n');
  }

  // 干净重写轮：措辞必须与补丁阶梯相反（整文件 Write，禁局部 Edit），
  // 否则和 attempts>=3 的"不要重写整页"在同一条注入消息里自相矛盾。
  if (phase === 'fresh_rewrite') {
    return [
      '<artifact-validation-failed kind="interactive_artifact">',
      attemptsLine,
      phaseLine,
      `target file: ${absolutePath}`,
      '补丁式修复已停用（停滞或补丁抗性失败码触发），本轮执行一次性干净重写。',
      issueSummary,
      repairSpecBlock,
      ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
      '先 Read 一次目标文件——磁盘上保留的是历史最佳版本，作为重写参照。',
      '然后用一次完整 Write 输出全新实现：一次性满足上面全部失败项，且不得回退已通过的验收项。',
      '不要在旧代码上做局部 Edit/Append；这是唯一一次重写机会，之后将按最佳版本降级收尾。',
      '</artifact-validation-failed>',
    ].join('\n');
  }

  if (attempts >= 3) {
    return [
      '<artifact-validation-failed kind="interactive_artifact">',
      attemptsLine,
      phaseLine,
      `target file: ${absolutePath}`,
      '同一个 artifact 文件已经连续多次 validation failed。',
      issueSummary,
      repairSpecBlock,
      ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
      '下一步最多只允许再 Read 一次这个目标文件，用来定位需要修改的片段。',
      'Repair 权限已经收窄到目标文件和验证命令；上面的失败摘要和 artifact_repair_spec 已经足够。',
      'Read 之后必须直接对这个文件做局部 Edit / Append，逐项补齐上面列出的 contract、metric 或 coverage 问题。',
      '如果需要确认修复结果，直接运行 validator；不要在修改前继续换只读工具兜圈子。',
      '不要把 __GAME_TEST__/__INTERACTIVE_TEST__ 改成脱离真实运行时的假 harness；start/reset/step/snapshot/runSmokeTest 必须驱动同一份游戏状态。',
      'coverage 只能在真实输入后的 before/after snapshot 变化分支里添加；enemy_present、spikes_present、ability exists、door reachable、mechanics registered 这类存在性兜底不能算通过证据。',
      platformerStructuralRepair
        ? '这是平台玩法结构性失败；如果局部补丁会继续保留不可达的布局或碰撞路径，可以完整 Write 目标 HTML，但必须保留单文件游戏、真实玩法和测试合约。'
        : '不要重写整页，不要改无关样式、文案或玩法；只有 HTML 结构已经损坏时才允许大段重写。',
      ...(platformerStructuralRepair
        ? [
            '完整修复必须同时改 live level layout / collision / step / snapshot / runSmokeTest，让踩怪、顶砖、拿技能、解锁 gate 都由真实输入触发，并由 before/after snapshot 证明。',
          ]
        : []),
      '修完后再验证，答案里不要把未修的问题包装成后续优化。',
      '</artifact-validation-failed>',
    ].join('\n');
  }

  if (attempts >= 2) {
    return [
      '<artifact-validation-failed kind="interactive_artifact">',
      attemptsLine,
      phaseLine,
      `target file: ${absolutePath}`,
      '这次只能修当前失败对应的范围，不要泛化成整页重做。',
      issueSummary,
      repairSpecBlock,
      ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
      '下一步只允许改这个文件，并且只修上面列出的 contract、metric 或 coverage 缺口。',
      'Repair 权限已经收窄到目标文件和验证命令；优先依据失败摘要直接补丁式修改目标文件。',
      '下一步动作必须是 Edit / Append / Bash(validator) 之一，不要在只读工具里循环；需要锚点时只做一次 ranged Read。',
      ...(platformerStructuralRepair
        ? [
            '平台玩法结构性失败可以用完整 Write 替换目标 HTML；不要只修 coverage 字段，必须让 live physics 路径和 runSmokeTest 走同一套状态。',
          ]
        : []),
      '不要把 __GAME_TEST__/__INTERACTIVE_TEST__ 改成脱离真实运行时的假 harness；必须驱动同一份 live game state。',
      'coverage 只能来自真实状态变化：移动坐标改变、得分增加、能力从 false 变 true、生命减少、关卡或模式通过门/目标规则改变。',
      '不要把对象存在、关卡加载成功、敌人/尖刺/能力道具存在、门存在或机制注册写进 coverage 当作通过。',
      '保持现有页面结构、已通过的玩法和无关内容不动，直接在原文件上补丁式修复。',
      '</artifact-validation-failed>',
    ].join('\n');
  }

  return [
    '<artifact-validation-failed kind="interactive_artifact">',
    attemptsLine,
    phaseLine,
    `target file: ${absolutePath}`,
    '你刚生成的是游戏或强交互 HTML，但当前交付还不满足真实可操作标准。',
    issueSummary,
    repairSpecBlock,
    ...formatBrowserVisualEvidenceForRepair(browserVisualSmoke),
    ...(platformerStructuralRepair
      ? [
          '平台玩法修复必须把布局、碰撞、奖励、能力和 gate 路线一起修到可达；只声明 gameplayMechanics 或只改 coverage 不算修复。',
        ]
      : []),
    '请直接修正现有文件，再继续验证；不要把这些缺口解释成未来优化项。',
    'runSmokeTest 的 coverage 只能记录由真实 step(input, frames) 触发的 before/after snapshot 变化，不能记录存在性或注册信息。',
    '优先依据失败摘要直接修改目标文件；如需确认结果，运行验证命令。',
    '</artifact-validation-failed>',
  ].join('\n');
}
