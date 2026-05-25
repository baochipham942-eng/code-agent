import type { Message } from '../../../../shared/contract';
import { REPAIR_PROMPT_LIMITS } from '../../../../shared/constants/repair';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { ContextAssemblyCtx } from '../contextAssembly';

const ARTIFACT_REPAIR_CONTEXT_PATTERN =
  /artifact[-\s_]*(validation|repair)|artifact validation failed|artifact repair|<artifact-validation-failed\b|artifactValidation[^]*failed/i;

type ArtifactValidationMetadata = {
  failed?: boolean;
  failures?: unknown;
  browserVisualSmoke?: unknown;
  attempts?: unknown;
  phase?: unknown;
  repairSpec?: {
    issues?: unknown;
  };
};

type ArtifactRepairToolMetadata = Record<string, unknown> & {
  artifactValidation?: ArtifactValidationMetadata;
  artifactRepairRollback?: {
    targetFile?: unknown;
    applied?: unknown;
    attempted?: unknown;
    keptImprovedPatch?: unknown;
  };
  artifactRepairGuard?: {
    lastBlockedTool?: unknown;
    blocked?: unknown;
  };
};

type ArtifactRepairToolResultLike = {
  output?: string;
  error?: string;
  metadata?: ArtifactRepairToolMetadata;
};

export function isArtifactRepairContent(content: unknown): boolean {
  return typeof content === 'string' && ARTIFACT_REPAIR_CONTEXT_PATTERN.test(content);
}

export function getArtifactRepairToolMetadata(result: { metadata?: Record<string, unknown> }): ArtifactRepairToolMetadata {
  return (result.metadata ?? {}) as ArtifactRepairToolMetadata;
}

function getIssueCode(issue: unknown): string | null {
  if (!issue || typeof issue !== 'object') return null;
  const code = (issue as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function hasRecentArtifactRepairToolFailure(ctx: ContextAssemblyCtx): boolean {
  const recentMessages = ctx.runtime.messages.slice(-8);
  for (const message of recentMessages) {
    if (message.role === 'tool') {
      if (isArtifactRepairContent(message.content)) return true;
      for (const result of message.toolResults ?? []) {
        if (result.success === false && (isArtifactRepairContent(result.error) || isArtifactRepairContent(result.output))) {
          return true;
        }
        if (getArtifactRepairToolMetadata(result).artifactValidation?.failed === true) {
          return true;
        }
      }
    }
  }
  return false;
}

export function getArtifactRepairContext(ctx: ContextAssemblyCtx): string[] {
  return ctx.getBudgetedPersistentSystemContext().filter(isArtifactRepairContent);
}

export function isArtifactRepairMode(ctx: ContextAssemblyCtx): boolean {
  return getArtifactRepairContext(ctx).length > 0 || hasRecentArtifactRepairToolFailure(ctx);
}

export function resolveArtifactRepairPath(ctx: ContextAssemblyCtx, filePath: string): string {
  return isAbsolute(filePath)
    ? filePath
    : resolvePath(ctx.runtime.workingDirectory || process.cwd(), filePath);
}

export function getArtifactRepairTargetFile(ctx: ContextAssemblyCtx): string | null {
  return typeof ctx.runtime.artifactRepairGuard?.targetFile === 'string'
    ? ctx.runtime.artifactRepairGuard.targetFile
    : null;
}

export function getArtifactRepairHistoryToolAllowlist(ctx: ContextAssemblyCtx): Set<string> | null {
  const guard = ctx.runtime.artifactRepairGuard;
  if (!guard) return null;
  // Route A: the history tool allowlist no longer narrows by read/block counters.
  // Pre-patch keeps Read + mutation history so the model always sees the full target
  // file; post-patch swaps Read for Bash so verification commands stay in context.
  if (guard.patched) {
    return new Set(['Edit', 'edit_file', 'Write', 'write_file', 'Append', 'append_file', 'Bash', 'bash']);
  }
  return new Set(['Read', 'read_file', 'Edit', 'edit_file', 'Write', 'write_file', 'Append', 'append_file']);
}

function buildArtifactRepairBlockedHistory(result: { metadata?: Record<string, unknown> }, originalContent: string): string {
  const guard = getArtifactRepairToolMetadata(result).artifactRepairGuard;
  const blockedTool = typeof guard?.lastBlockedTool === 'string' ? guard.lastBlockedTool : 'tool';
  return [
    '<artifact-repair-tool-blocked>',
    `Blocked ${blockedTool} during repair mode.`,
    'Do not inspect validator/runtime sources again.',
    'Use the target HTML file and validator output only.',
    originalContent,
    '</artifact-repair-tool-blocked>',
  ].join('\n');
}

function buildArtifactRepairValidationFailureHistory(
  ctx: ContextAssemblyCtx,
  result: { metadata?: Record<string, unknown> },
  originalContent: string,
): string {
  const metadata = getArtifactRepairToolMetadata(result);
  const validation = metadata.artifactValidation;
  const rollback = metadata.artifactRepairRollback;
  const repairSpec = validation?.repairSpec;
  const issueCodes = Array.isArray(repairSpec?.issues)
    ? repairSpec.issues
        .map(getIssueCode)
        .filter(Boolean)
    : [];
  const failures: string[] = Array.isArray(validation?.failures)
    ? validation.failures.filter((failure: unknown): failure is string => typeof failure === 'string')
    : [];
  const browserVisualSmoke = validation?.browserVisualSmoke;
  const browserVisualSmokeObject = browserVisualSmoke && typeof browserVisualSmoke === 'object'
    ? (browserVisualSmoke as {
        attempted?: unknown;
      passed?: unknown;
      skipped?: unknown;
      checks?: unknown;
      failures?: unknown;
      diagnostics?: unknown;
    })
    : null;
  const browserVisualSmokeDiagnostics = browserVisualSmokeObject?.diagnostics && typeof browserVisualSmokeObject.diagnostics === 'object'
    ? browserVisualSmokeObject.diagnostics as { computerUseFallback?: unknown }
    : null;
  const computerUseFallback = browserVisualSmokeDiagnostics?.computerUseFallback && typeof browserVisualSmokeDiagnostics.computerUseFallback === 'object'
    ? browserVisualSmokeDiagnostics.computerUseFallback as { screenshotPath?: unknown; frontmostApp?: unknown }
    : null;
  const frontendEvidence: string[] = browserVisualSmokeObject
    ? [
        `Frontend browser validation: attempted=${browserVisualSmokeObject.attempted === true}, passed=${browserVisualSmokeObject.passed === true}${browserVisualSmokeObject.skipped === true ? ', skipped=true' : ''}`,
        ...(
          Array.isArray(browserVisualSmokeObject.checks)
            ? browserVisualSmokeObject.checks.filter((check: unknown): check is string => typeof check === 'string').slice(0, 2)
            : []
        ).map((check: string) => `Frontend check: ${check}`),
        ...(
          Array.isArray(browserVisualSmokeObject.failures)
            ? browserVisualSmokeObject.failures.filter((failure: unknown): failure is string => typeof failure === 'string').slice(0, 2)
            : []
        ).map((failure: string) => `Frontend failure: ${failure}`),
        computerUseFallback
          ? `Frontend Computer Use fallback: screenshot=${typeof computerUseFallback.screenshotPath === 'string' ? computerUseFallback.screenshotPath : '(none)'}, frontmost=${typeof computerUseFallback.frontmostApp === 'string' ? computerUseFallback.frontmostApp : '(unknown)'}`
          : null,
      ]
        .filter((line): line is string => typeof line === 'string')
    : [];
  const targetFile = typeof rollback?.targetFile === 'string'
    ? rollback.targetFile
    : getArtifactRepairTargetFile(ctx) || 'target artifact';
  const lines = [
    '<artifact-validation-failed-history>',
    `Target file: ${targetFile}`,
    typeof validation?.attempts === 'number' ? `attempts: ${validation.attempts}` : null,
    typeof validation?.phase === 'string' ? `repair phase: ${validation.phase}` : null,
    rollback?.keptImprovedPatch === true
      ? 'The failed patch improved validation and was kept as the next repair baseline.'
      : rollback?.applied === true
      ? 'The failed patch was rolled back; edit from the last valid pre-patch file state.'
      : rollback?.attempted === true
        ? 'Rollback was attempted but did not apply; inspect only the target artifact if needed.'
        : null,
    issueCodes.length > 0 ? `Issue codes: ${issueCodes.join(', ')}` : null,
    ...failures.slice(0, 4).map((failure, index) => `${index + 1}. ${failure}`),
    ...frontendEvidence,
    'Full repair spec is already injected as the current system repair instruction; do not re-process duplicated history.',
    'Next action: fix the target HTML now — prefer one complete Write of the whole self-contained artifact, or a focused Edit/Append when the patch anchors cleanly, then validate.',
    '</artifact-validation-failed-history>',
  ].filter((line): line is string => typeof line === 'string' && line.length > 0);

  if (lines.length <= 7 && originalContent.length < 1_500) {
    return originalContent;
  }
  return lines.join('\n');
}

function cleanArtifactRepairTargetPath(value: string): string {
  return value.trim().replace(/^`|`$/g, '').replace(/[。.]$/, '');
}

function extractArtifactRepairTargetFromContext(blocks: string[]): string | null {
  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      const targetLine = /^(?:target file|Target file):\s*(.+)$/i.exec(line);
      if (targetLine?.[1]) return cleanArtifactRepairTargetPath(targetLine[1]);

      const failureLine = /^Artifact validation failed for\s+(.+)$/i.exec(line);
      if (failureLine?.[1]) return cleanArtifactRepairTargetPath(failureLine[1]);
    }
  }
  return null;
}

function pushUniqueLimited(target: string[], value: string, limit = REPAIR_PROMPT_LIMITS.HISTORY_ITEM_LIMIT): void {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || target.includes(normalized) || target.length >= limit) return;
  const maxLength = REPAIR_PROMPT_LIMITS.HISTORY_ITEM_CHARS;
  target.push(normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...` : normalized);
}

function getRecentArtifactRepairValidationFailures(ctx: ContextAssemblyCtx): string[] {
  const failures: string[] = [];
  for (const message of ctx.runtime.messages.slice(-10)) {
    if (message.role !== 'tool') continue;
    for (const result of message.toolResults ?? []) {
      const artifactValidation = getArtifactRepairToolMetadata(result).artifactValidation;
      if (artifactValidation?.failed !== true) continue;
      const validationFailures = artifactValidation.failures;
      if (Array.isArray(validationFailures)) {
        for (const failure of validationFailures) {
          if (typeof failure === 'string') pushUniqueLimited(failures, failure);
        }
      }
    }
  }
  return failures;
}

function extractArtifactRepairFailureSummary(ctx: ContextAssemblyCtx, blocks: string[]): string[] {
  const failures = getRecentArtifactRepairValidationFailures(ctx);

  for (const block of blocks) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      const numbered = /^\d+\.\s+(.+)$/.exec(line);
      if (numbered?.[1] && !/^x+$/.test(numbered[1])) {
        pushUniqueLimited(failures, numbered[1]);
        continue;
      }

      const issueCodes = /^Issue codes:\s*(.+)$/i.exec(line);
      if (issueCodes?.[1]) {
        pushUniqueLimited(failures, `Issue codes: ${issueCodes[1]}`);
      }
    }
  }

  const guardIssueCodes = ctx.runtime.artifactRepairGuard?.activeIssueCodes || [];
  if (guardIssueCodes.length > 0) {
    pushUniqueLimited(failures, `Active issue codes: ${guardIssueCodes.join(', ')}`);
  }

  return failures;
}

function buildArtifactRepairDirectRequirements(failuresAndCodes: string[]): string[] {
  const text = failuresAndCodes.join('\n');
  const requirements: string[] = [];

  if (/missing_test_contract|malformed_test_contract|missing_contract_start|missing_contract_snapshot|missing_contract_smoke|可平衡解析的对象字面量|交互测试合约.*缺少|没有找到 runSmokeTest/i.test(text)) {
    requirements.push(
      '- test_contract_shape: replace the active `window.__GAME_TEST__` / `window.__INTERACTIVE_TEST__` region with one direct balanced object assignment containing `start()`, `reset(levelOrScenario?)`, `snapshot()`, `step(inputState = {}, frames = 1)`, and `runSmokeTest()`. Do not use comments, class/factory/IIFE wrappers, `Object.assign`, separate top-level function shells, or duplicate method tails after the object closes.',
    );
  }

  if (/missing_contract_start|缺少 start\(\)|缺少 start/i.test(text)) {
    requirements.push(
      '- missing_contract_start: add a real `start()` method to the active `window.__GAME_TEST__` / `window.__INTERACTIVE_TEST__` object; it must initialize clean playable state and use the same state as `snapshot()`, `step()`, and `runSmokeTest()`.',
    );
  }

  if (/missing_coverage_metadata|缺少可用于验收的.*(?:关卡|片段|场景|目标)元数据/i.test(text)) {
    requirements.push(
      '- missing_coverage_metadata: add literal `window.__GAME_META__` / `window.__INTERACTIVE_META__` metadata with validator-readable authored units such as `levels`, `segments`, `scenarios`, `stages`, `missions`, or `objectives`; also include `qualityPlan` or `acceptance`, and exact `progressPlan` or `reachability` array steps with real controls and snapshot metrics. Generic `progress` or `coverage` objects do not satisfy the reachability validator.',
    );
  }

  if (/smoke_missing_coverage|缺少 coverage|coverage 没有覆盖|coverage 没有证明/i.test(text)) {
    requirements.push(
      '- smoke_missing_coverage: make `runSmokeTest()` return structured input-driven coverage for mechanics, rewards, risks, stateChanges, and every authored level/scenario/segment; do not count metadata, registration, object existence, or direct state grants.',
    );
  }

  if (/missing_snapshot_metric|non_executable_reachability_input|control_no_state_change|metric ".*" 不在 snapshot|缺少可执行输入|没有让 .* 满足/i.test(text)) {
    requirements.push(
      '- reachability_evidence: every `progressPlan` / `reachability` step must use dispatchable metadata controls and a real `snapshot()` path that changes within the declared frames. Do not assert score/progress/win/gate/ability changes after generic movement unless that exact live input path triggers the state change.',
    );
  }

  if (/reset_authored_unit_failed|reset\(levelOrScenario\) failed for authored unit|levelOrScenario.*authored/i.test(text)) {
    requirements.push(
      '- reset_authored_unit_failed: make `reset(levelOrScenario?)` accept every declared authored unit id/key/name and numeric index, mapping strings like `level1` or `stomp` to the same live initialization path used by playable state.',
    );
  }

  if (/missing_gameplay_mechanics|gameplayMechanics|stompable|comboChallenge|requiresAbility|blocksAccessTo/i.test(text)) {
    requirements.push(
      '- platformer_gameplay_mechanics: for platformer artifacts, add `gameplayMechanics` with stompable enemies, bumpable/question blocks, route-changing abilities, ability-gated routes, and comboChallenge; prove each through `step()` plus before/after `snapshot()` evidence in `runSmokeTest()`.',
    );
  }

  if (/breakout|arkanoid|wallBounceCount|paddleBounceCount|brickCount|bricksRemaining|powerup/i.test(text)) {
    requirements.push(
      '- breakout_gameplay_contract: for Breakout/Arkanoid artifacts, expose `paddleX`, `ball`, `wallBounceCount`, `paddleBounceCount`, `brickCount` or `bricksRemaining`, `score`, and deterministic `reset()` scenarios for paddleMove, launch, wallBounce, paddleBounce, brickHit, powerup:wide/multi/slow/through/life, win, and lose; each must produce before/after `snapshot()` evidence through live `step()`. Also start the real browser loop before final script exit, and make a real Space key press from the start screen move ball.x or ball.y.',
    );
  }

  if (/canvas_not_responsive|固定 canvas|窄窗口.*裁切|horizontal canvas overflow|none are visibly framed|mobile visual smoke.*canvas|browser visual smoke.*canvas|distorted game canvas aspect ratio|primary game canvas is undersized|aspect ratio|small centered playfield|large empty margins|preview surface|变形|响应式 CSS|responsive css/i.test(text)) {
    requirements.push(
      '- canvas_not_responsive: keep the drawing resolution if useful, but constrain both rendered width and height with responsive canvas or wrapper CSS such as max-width: calc(100vw - 16px), max-height: calc(100dvh - 16px), aspect-ratio, and height:auto. The rendered CSS aspect ratio must match the canvas internal width/height, so do not render 480x640 as a 4:3 or 16:9 box. The full playfield and HUD must fit inside a 390px mobile viewport, and wide desktop previews should scale the primary playfield up instead of leaving large empty margins; fixed 800px/900px width or max-height-only scaling is not enough.',
    );
  }

  return requirements.length > 0
    ? ['Direct repair requirements:', ...requirements]
    : [];
}

export function buildArtifactRepairFocusBlock(ctx: ContextAssemblyCtx, repairContextBlocks: string[]): string | null {
  const guard = ctx.runtime.artifactRepairGuard;
  const targetFile = getArtifactRepairTargetFile(ctx) || extractArtifactRepairTargetFromContext(repairContextBlocks);
  if (!targetFile && repairContextBlocks.length === 0) return null;

  const failures = extractArtifactRepairFailureSummary(ctx, repairContextBlocks);

  const directRequirements = buildArtifactRepairDirectRequirements([
    ...failures,
    ...(guard?.activeIssueCodes ?? []),
  ]);

  return [
    '<artifact-repair-focus>',
    targetFile ? `Target file: ${targetFile}` : 'Target file: use the artifact file named by the validation failure.',
    guard?.phase ? `Repair phase: ${guard.phase}` : null,
    typeof guard?.attempts === 'number' ? `Attempts: ${guard.attempts}` : null,
    failures.length > 0 ? 'Validation failures to fix now:' : 'Validation failures to fix now: use the validator failure summary already in context.',
    ...failures.map((failure, index) => `${index + 1}. ${failure}`),
    ...directRequirements,
    'Allowed actions now:',
    '- Edit, Append, or Write the target file now. Prefer one complete Write of the whole self-contained HTML when the repair spans gameplay, metadata, and rendering; use a focused Edit/Append when the patch anchors cleanly.',
    '- Read the target file as needed for exact anchors before patching.',
    guard?.patched === true
      ? '- Bash may run validator/test/typecheck/lint/build verification; inspect only the result.'
      : '- Bash verification is only useful after patching the target file.',
    'Blocked actions:',
    '- Do not use Grep, Glob, Task, ToolSearch, broad Bash source reads, or reads of validator/runtime/unrelated source files.',
    'Next write requirement:',
    targetFile
      ? `- Repair ${targetFile} directly. If a targeted patch is brittle, Write one complete HTML document that fixes gameplayMechanics, runtime state, frontend rendering, and runSmokeTest evidence together; after the patch, run the validator and use only its result.`
      : '- Repair the target artifact directly. If a targeted patch is brittle, Write one complete HTML document that fixes metadata, runtime state, frontend rendering, and smoke evidence together; after the patch, run the validator and use only its result.',
    '- Keep the interactive contract tied to live gameplay state; do not add placeholder probes, direct state grants, or existence-only coverage.',
    '</artifact-repair-focus>',
  ].filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
}

export function formatArtifactRepairToolResultContent(
  ctx: ContextAssemblyCtx,
  result: ArtifactRepairToolResultLike,
  originalContent: string,
): string {
  const targetFile = getArtifactRepairTargetFile(ctx);
  if (!targetFile) return originalContent;

  if (result.metadata?.artifactRepairGuard?.blocked === true) {
    return buildArtifactRepairBlockedHistory(result, originalContent);
  }

  if (result.metadata?.artifactValidation?.failed === true) {
    return buildArtifactRepairValidationFailureHistory(ctx, result, originalContent);
  }

  // Route A: the artifact under repair is always kept at full content. The model
  // needs the complete file to anchor edits or do a full rewrite — compressing it
  // is what made large-game repair fail.
  return originalContent;
}

export function getAllowedArtifactRepairToolCallIds(ctx: ContextAssemblyCtx, messages: Message[]): Set<string> | null {
  const allowlist = getArtifactRepairHistoryToolAllowlist(ctx);
  if (!allowlist) return null;

  const allowedIds = new Set<string>();
  const targetFile = getArtifactRepairTargetFile(ctx);
  const targetReadResultIds = new Set<string>();

  for (const message of messages) {
    if (!message.toolResults?.length || !targetFile) continue;
    for (const result of message.toolResults) {
      const resultFilePath = typeof result.metadata?.filePath === 'string'
        ? result.metadata.filePath
        : null;
      if (
        result.toolCallId &&
        result.success === true &&
        result.metadata?.evidenceKind === 'file_read' &&
        resultFilePath &&
        resolveArtifactRepairPath(ctx, resultFilePath) === targetFile
      ) {
        targetReadResultIds.add(result.toolCallId);
      }
    }
  }

  for (const message of messages) {
    if (!message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      const toolName = toolCall.name;
      if (allowlist.has(toolName) || targetReadResultIds.has(toolCall.id)) {
        allowedIds.add(toolCall.id);
      }
    }
  }
  return allowedIds;
}

export function hasGameArtifactRepairSignals(ctx: ContextAssemblyCtx, userQuery: string): boolean {
  if (!isArtifactRepairMode(ctx)) return false;
  const repairContext = getArtifactRepairContext(ctx).join('\n');
  const targetFile = getArtifactRepairTargetFile(ctx) || '';
  const recentFailures = getRecentArtifactRepairValidationFailures(ctx).join('\n');
  const signalText = [
    userQuery,
    targetFile,
    repairContext,
    recentFailures,
    ...(ctx.runtime.artifactRepairGuard?.activeIssueCodes ?? []),
  ].join('\n');

  return /__GAME_(?:META|TEST)__|game_artifact|\.game\.html\b|game\.html\b|\bgame\b|游戏|关卡|level|stage|platformer|runner|tower[_\s-]?defense|puzzle|mario|超级玛丽/i.test(signalText);
}
