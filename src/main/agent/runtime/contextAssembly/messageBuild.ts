// ContextAssembly - Model message construction and transcript projection.
import type { Message } from '../../../../shared/contract';
import type { ContextInterventionSnapshot } from '../../../../shared/contract/contextView';
import { getContextWindow } from '../../../../shared/constants';
import type { ModelMessage } from '../../../agent/loopTypes';
import { formatToolCallForHistory, buildMultimodalContent } from '../../../agent/messageHandling/converter';
import {
  injectWorkingDirectoryContext,
  buildEnhancedSystemPrompt,
  buildRuntimeModeBlock,
} from '../../../agent/messageHandling/contextBuilder';
import { loadMemoryIndex } from '../../../lightMemory/indexLoader';
import { loadRelevantSkills, buildSkillInjectionBlock } from '../../../lightMemory/skillLoader';
import { getRepoMap } from '../../../context/repoMap';
import { buildSessionMetadataBlock } from '../../../lightMemory/sessionMetadata';
import { buildRecentConversationsBlock } from '../../../lightMemory/recentConversations';
import {
  getPromptForTask,
  needsGenerativeUI,
  GENERATIVE_UI_PROMPT,
  QUESTION_FORM_PROMPT,
  ARTIFACT_TASK_BRIEF_PROMPT,
  needsArtifactTaskBrief,
} from '../../../prompts/builder';
import {
  GAME_ARTIFACT_CONTRACT_PROMPT,
  GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT,
  needsGameArtifactContract,
} from '../../../prompts/artifactGeneration';
import { buildActiveAgentContext, drainCompletionNotifications } from '../../../agent/activeAgentContext';
import { getDeferredToolsSummary } from '../../../tools/dispatch/toolDefinitions';
import { estimateModelMessageTokens, estimateTokens } from '../../../context/tokenOptimizer';
import { compactModelSummarize } from '../../../context/compactModel';
import { CompressionState } from '../../../context/compressionState';
import { getContextInterventionState } from '../../../context/contextInterventionState';
import { applyInterventionsToMessages } from '../../../context/contextInterventionHelpers';
import { getContextEventLedger } from '../../../context/contextEventLedger';
import { getSystemPromptCache } from '../../../telemetry/systemPromptCache';
import { logCollector } from '../../../mcp/logCollector.js';
import { countTraceEntries, recordMemoryInjectionTrace } from '../../../memory/memoryInjectionTrace';
import { createHash } from 'crypto';
import { REPAIR_PROMPT_LIMITS } from '../../../../shared/constants/repair';
import { isAbsolute, resolve as resolvePath } from 'path';
import type { ContextAssemblyCtx, ContextTranscriptEntry } from '../contextAssembly';
import { logger, MAX_SYSTEM_PROMPT_TOKENS } from '../contextAssembly';
import { persistRuntimeState } from '../runtimeStatePersistence';

const DYNAMIC_PROMPT_CACHE_TTL_MS = 2 * 60 * 1000;
const COMPRESSION_CACHE_TTL_MS = 30 * 1000;

const MEMORY_INTENT_PATTERN = /记忆|记得|回忆|之前|上次|上一次|历史|先前|previous|remember|recall|memory|before|earlier/i;
const RECENT_CONVERSATIONS_INTENT_PATTERN = /继续|接着|上次|上一轮|之前|历史|recent|previous|continue|resume|earlier/i;
const REPO_MAP_INTENT_PATTERN = /代码|仓库|文件|实现|测试|修复|报错|构建|重构|性能|源码|模块|函数|类|bug|repo|code|file|test|fix|implement|refactor|build|performance|source|module/i;
const ARTIFACT_REPAIR_CONTEXT_PATTERN =
  /artifact[-\s_]*(validation|repair)|artifact validation failed|artifact repair|<artifact-validation-failed\b|artifactValidation[^]*failed/i;
type RuntimeAssemblyCache = {
  dynamicPrompt?: {
    key: string;
    createdAt: number;
    prompt: string;
    tokens: number;
  };
  compression?: {
    key: string;
    createdAt: number;
    apiView: ContextTranscriptEntry[];
    state: string;
  };
};

type PromptAppendPolicy =
  | { kind: 'optional' }
  | { kind: 'required'; trimCandidates?: string[] };

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

const runtimeAssemblyCaches = new WeakMap<object, RuntimeAssemblyCache>();

function getRuntimeAssemblyCache(ctx: ContextAssemblyCtx): RuntimeAssemblyCache {
  let cache = runtimeAssemblyCaches.get(ctx.runtime as unknown as object);
  if (!cache) {
    cache = {};
    runtimeAssemblyCaches.set(ctx.runtime as unknown as object, cache);
  }
  return cache;
}

function getLastUserMessage(ctx: ContextAssemblyCtx): Message | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(types): runtime.messages 类型 Message[] 已存在，find 回调可直接用 (m: Message)，不需要 any
  return [...ctx.runtime.messages].reverse().find((m: any) => m.role === 'user');
}

function isArtifactRepairContent(content: unknown): boolean {
  return typeof content === 'string' && ARTIFACT_REPAIR_CONTEXT_PATTERN.test(content);
}

function getArtifactRepairToolMetadata(result: { metadata?: Record<string, unknown> }): ArtifactRepairToolMetadata {
  return (result.metadata ?? {}) as ArtifactRepairToolMetadata;
}

function getIssueCode(issue: unknown): string | null {
  if (!issue || typeof issue !== 'object') return null;
  const code = (issue as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function hasRecentArtifactRepairToolFailure(ctx: ContextAssemblyCtx): boolean {
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

function getArtifactRepairContext(ctx: ContextAssemblyCtx): string[] {
  return ctx.getBudgetedPersistentSystemContext().filter(isArtifactRepairContent);
}

function isArtifactRepairMode(ctx: ContextAssemblyCtx): boolean {
  return getArtifactRepairContext(ctx).length > 0 || hasRecentArtifactRepairToolFailure(ctx);
}

function resolveArtifactRepairPath(ctx: ContextAssemblyCtx, filePath: string): string {
  return isAbsolute(filePath)
    ? filePath
    : resolvePath(ctx.runtime.workingDirectory || process.cwd(), filePath);
}

function getArtifactRepairTargetFile(ctx: ContextAssemblyCtx): string | null {
  return typeof ctx.runtime.artifactRepairGuard?.targetFile === 'string'
    ? ctx.runtime.artifactRepairGuard.targetFile
    : null;
}

function getArtifactRepairHistoryToolAllowlist(ctx: ContextAssemblyCtx): Set<string> | null {
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

  if (/missing_gameplay_mechanics|gameplayMechanics|stompable|comboChallenge|requiresAbility|blocksAccessTo/i.test(text)) {
    requirements.push(
      '- platformer_gameplay_mechanics: for platformer artifacts, add `gameplayMechanics` with stompable enemies, bumpable/question blocks, route-changing abilities, ability-gated routes, and comboChallenge; prove each through `step()` plus before/after `snapshot()` evidence in `runSmokeTest()`.',
    );
  }

  if (/breakout|arkanoid|wallBounceCount|paddleBounceCount|brickCount|bricksRemaining|powerup/i.test(text)) {
    requirements.push(
      '- breakout_gameplay_contract: for Breakout/Arkanoid artifacts, expose `paddleX`, `ball`, `wallBounceCount`, `paddleBounceCount`, `brickCount` or `bricksRemaining`, `score`, and deterministic `reset()` scenarios for paddleMove, launch, wallBounce, paddleBounce, brickHit, powerup:wide/multi/slow/through/life, win, and lose; each must produce before/after `snapshot()` evidence through live `step()`.',
    );
  }

  if (/canvas_not_responsive|固定 canvas|窄窗口.*裁切|horizontal canvas overflow|none are visibly framed|mobile visual smoke.*canvas|响应式 CSS|responsive css/i.test(text)) {
    requirements.push(
      '- canvas_not_responsive: keep the drawing resolution if useful, but constrain both rendered width and height with responsive canvas or wrapper CSS such as max-width: calc(100vw - 16px), max-height: calc(100dvh - 16px), aspect-ratio, and height:auto. The full playfield and HUD must fit inside a 390px mobile viewport; fixed 800px/900px width or max-height-only scaling is not enough.',
    );
  }

  return requirements.length > 0
    ? ['Direct repair requirements:', ...requirements]
    : [];
}

function buildArtifactRepairFocusBlock(ctx: ContextAssemblyCtx, repairContextBlocks: string[]): string | null {
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

function getAllowedArtifactRepairToolCallIds(ctx: ContextAssemblyCtx, messages: Message[]): Set<string> | null {
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

function buildDynamicPromptCacheKey(ctx: ContextAssemblyCtx, userQuery: string, artifactRepairMode: boolean): string {
  return [
    ctx.runtime.sessionId,
    ctx.runtime.agentId || '',
    ctx.runtime.workingDirectory || '',
    String(ctx.runtime.isDefaultWorkingDirectory),
    String(ctx.runtime.isSimpleTaskMode),
    String(ctx.runtime.enableToolDeferredLoading),
    ctx.runtime.modelConfig.model || '',
    getLastUserMessage(ctx)?.id || '',
    ctx.runtime.activeSkillInvocation?.skillName || '',
    ctx.runtime.activeSkillContextBlock ? 'active-skill' : '',
    artifactRepairMode ? 'artifact-repair' : 'normal',
    userQuery,
  ].join('\u0000');
}

function hasGameArtifactRepairSignals(ctx: ContextAssemblyCtx, userQuery: string): boolean {
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

function appendPromptBlockWithinBudget(
  prompt: string,
  block: string | null | undefined,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (!block) return prompt;
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(`[ContextAssembly] Skipping ${label}: system prompt budget would be ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`);
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算跳过 ${label}：预计 ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
    return prompt;
  }
  return nextPrompt;
}

function appendRequiredPromptBlock(
  prompt: string,
  block: string,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(
      `[ContextAssembly] Preserving required ${label}: system prompt budget is ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算保留必需 ${label}：预计 ${nextTokens}/${MAX_SYSTEM_PROMPT_TOKENS} tokens`,
    );
  }
  return nextPrompt;
}

function removePromptBlock(prompt: string, block: string | null | undefined): string {
  if (!block) return prompt;
  const escapedBlock = block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prompt
    .replace(new RegExp(`\\n\\n${escapedBlock}`), '')
    .replace(new RegExp(`^${escapedBlock}\\n\\n`), '')
    .replace(new RegExp(`^${escapedBlock}$`), '');
}

function trimPreambleBeforeRequiredArtifactBlock(
  prompt: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (estimateTokens(prompt) <= MAX_SYSTEM_PROMPT_TOKENS) return prompt;

  const markerMatch = /\n\n## Game Artifact (?:Repair )?Contract\b/.exec(prompt);
  if (!markerMatch || typeof markerMatch.index !== 'number' || markerMatch.index <= 0) return prompt;

  const suffix = prompt.slice(markerMatch.index);
  let prefix = prompt.slice(0, markerMatch.index);
  const trimNotice = '\n[base prompt trimmed to preserve required artifact contract]\n';

  while (prefix.length > 0 && estimateTokens(`${prefix}${trimNotice}${suffix}`) > MAX_SYSTEM_PROMPT_TOKENS) {
    const overflow = estimateTokens(`${prefix}${trimNotice}${suffix}`) - MAX_SYSTEM_PROMPT_TOKENS;
    const removeChars = Math.max(240, overflow * 5);
    prefix = prefix.slice(0, Math.max(0, prefix.length - removeChars)).trimEnd();
  }

  const trimmedPrompt = `${prefix}${trimNotice}${suffix}`;
  if (estimateTokens(trimmedPrompt) <= MAX_SYSTEM_PROMPT_TOKENS) {
    ctx?.runtime.pendingRuntimeDiagnostics.push('上下文预算压缩 base prompt：保留必需 game artifact contract');
    return trimmedPrompt;
  }

  return prompt;
}

function appendPromptBlockWithinBudgetWithStatus(
  prompt: string,
  block: string | null | undefined,
  label: string,
  appendedBlocks: Map<string, string>,
  ctx?: ContextAssemblyCtx,
  policy: PromptAppendPolicy = { kind: 'optional' },
): { prompt: string; appended: boolean; trimmed?: string[] } {
  if (!block) {
    return { prompt, appended: false, trimmed: [] };
  }
  const nextPrompt = appendPromptBlockWithinBudget(prompt, block, label, ctx);
  if (nextPrompt !== prompt) {
    return { prompt: nextPrompt, appended: true, trimmed: [] };
  }
  if (policy.kind !== 'required') {
    return { prompt, appended: false, trimmed: [] };
  }

  const trimmed: string[] = [];
  let workingPrompt = prompt;
  for (const candidate of policy.trimCandidates ?? []) {
    const candidateBlock = appendedBlocks.get(candidate);
    if (!candidateBlock) continue;
    const nextCandidatePrompt = removePromptBlock(workingPrompt, candidateBlock);
    if (nextCandidatePrompt === workingPrompt) continue;
    workingPrompt = nextCandidatePrompt;
    appendedBlocks.delete(candidate);
    trimmed.push(candidate);
    const retriedPrompt = appendPromptBlockWithinBudget(workingPrompt, block, label, ctx);
    if (retriedPrompt !== workingPrompt) {
      return { prompt: retriedPrompt, appended: true, trimmed };
    }
  }

  return {
    prompt: appendRequiredPromptBlock(workingPrompt, block, label, ctx),
    appended: true,
    trimmed,
  };
}

const REQUIRED_REPAIR_TRIM_CANDIDATES = [
  'repo map',
  'skills',
  'recent conversations',
  'deferred tools',
  'generative UI',
  'question form',
  'active agent context',
  'completion notifications',
];

async function buildCachedDynamicSystemPrompt(ctx: ContextAssemblyCtx): Promise<string> {
  const lastUserMessage = getLastUserMessage(ctx);
  const userQuery = typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';
  const artifactRepairMode = isArtifactRepairMode(ctx);
  const cacheKey = buildDynamicPromptCacheKey(ctx, userQuery, artifactRepairMode);
  const cache = getRuntimeAssemblyCache(ctx);
  const cached = cache.dynamicPrompt;
  const now = Date.now();

  if (cached?.key === cacheKey && now - cached.createdAt < DYNAMIC_PROMPT_CACHE_TTL_MS) {
    logger.debug('[ContextAssembly] dynamic system prompt cache hit', { tokens: cached.tokens });
    return cached.prompt;
  }

  // Use optimized prompt based on task complexity
  let systemPrompt = getPromptForTask();
  const appendedBlocks = new Map<string, string>();
  const shouldInjectArtifactBrief = artifactRepairMode || (typeof userQuery === 'string' && needsArtifactTaskBrief(userQuery));
  const shouldInjectGameContract =
    (typeof userQuery === 'string' && needsGameArtifactContract(userQuery))
    || hasGameArtifactRepairSignals(ctx, userQuery);
  const shouldInjectGenerativeUI = typeof userQuery === 'string' && needsGenerativeUI(userQuery);

  if (shouldInjectArtifactBrief) {
    const artifactPromptBlock = shouldInjectGameContract
      ? artifactRepairMode
        ? GAME_ARTIFACT_REPAIR_CONTRACT_PROMPT
        : GAME_ARTIFACT_CONTRACT_PROMPT
      : ARTIFACT_TASK_BRIEF_PROMPT;
    const artifactPromptLabel = shouldInjectGameContract
      ? artifactRepairMode
        ? 'game artifact repair contract'
        : 'game artifact contract'
      : 'artifact task brief';
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      artifactPromptBlock,
      artifactPromptLabel,
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: ['repo map', 'skills', 'recent conversations', 'deferred tools'] },
    );
    systemPrompt = result.prompt;
    if (result.appended) {
      appendedBlocks.set(artifactPromptLabel, artifactPromptBlock);
      logger.debug(
        `[ContextAssembly] ${artifactPromptLabel} prompt injected (${artifactRepairMode ? 'repair mode' : 'intent matched'})`,
      );
      if (result.trimmed?.length) {
        logger.warn(`[ContextAssembly] Trimmed prompt blocks to preserve ${artifactPromptLabel}: ${result.trimmed.join(', ')}`);
      }
    }
  }

  if (ctx.runtime.activeSkillContextBlock) {
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      ctx.runtime.activeSkillContextBlock,
      `active skill ${ctx.runtime.activeSkillInvocation?.skillName || ''}`.trim(),
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: ['repo map', 'skills', 'recent conversations', 'deferred tools', 'generative UI', 'question form'] },
    );
    systemPrompt = result.prompt;
    if (result.appended) {
      appendedBlocks.set('active skill', ctx.runtime.activeSkillContextBlock);
      logger.debug('[ContextAssembly] Active skill invocation prompt injected', {
        skillName: ctx.runtime.activeSkillInvocation?.skillName,
        matchKind: ctx.runtime.activeSkillInvocation?.matchKind,
      });
    }
  }

  const genNum = 8;
  if (genNum >= 3 && !ctx.runtime.isSimpleTaskMode) {
    // Only enhance with RAG for non-simple tasks
    systemPrompt = await buildEnhancedSystemPrompt(systemPrompt, userQuery, ctx.runtime.isSimpleTaskMode);
  }

  systemPrompt = injectWorkingDirectoryContext(systemPrompt, ctx.runtime.workingDirectory, ctx.runtime.isDefaultWorkingDirectory);
  systemPrompt += buildRuntimeModeBlock();

  // 注入 Session Metadata（使用频率/行为模式，借鉴 ChatGPT Layer 2）
  if (!artifactRepairMode && !shouldInjectArtifactBrief) {
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      await buildSessionMetadataBlock(),
      'session metadata',
      ctx,
    );
  }

  // 注入轻量记忆索引（File-as-Memory）
  // 先做意图判断，避免每轮无条件读 INDEX.md。
  if (!artifactRepairMode && !shouldInjectArtifactBrief && typeof userQuery === 'string' && MEMORY_INTENT_PATTERN.test(userQuery)) {
    const memoryIndex = await loadMemoryIndex();
    if (memoryIndex) {
      const memoryIndexBlock = `<memory_index>\n${memoryIndex}\n</memory_index>`;
      const beforeMemoryIndex = systemPrompt;
      systemPrompt = appendPromptBlockWithinBudget(
        systemPrompt,
        memoryIndexBlock,
        'memory index',
        ctx,
      );
      recordMemoryInjectionTrace({
        blockType: 'memory_index',
        trigger: 'memory_intent',
        chars: memoryIndex.length,
        injected: systemPrompt !== beforeMemoryIndex,
        source: 'light-memory-index',
        count: countTraceEntries(memoryIndex),
        sessionId: ctx.runtime.sessionId,
      });
      logger.debug('[ContextAssembly] memory_index injected (intent matched)');
    } else {
      recordMemoryInjectionTrace({
        blockType: 'memory_index',
        trigger: 'memory_intent_empty',
        chars: 0,
        injected: false,
        source: 'light-memory-index',
        count: 0,
        sessionId: ctx.runtime.sessionId,
      });
    }
  } else if (!artifactRepairMode && !shouldInjectArtifactBrief) {
    // 日常对话：只放短提示，让模型知道可以用 MemoryRead 工具按需查，不读取索引文件。
    const memoryHintBlock = '<memory_hint>Memory files available via MemoryRead tool (see ~/.code-agent/memory/).</memory_hint>';
    const beforeMemoryHint = systemPrompt;
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      memoryHintBlock,
      'memory hint',
      ctx,
    );
    recordMemoryInjectionTrace({
      blockType: 'memory_hint',
      trigger: 'default_memory_hint',
      chars: memoryHintBlock.length,
      injected: systemPrompt !== beforeMemoryHint,
      source: 'light-memory-tool-hint',
      count: 1,
      sessionId: ctx.runtime.sessionId,
    });
  }

  // 注入相关 Skill（Hermes Procedural layer）— 按用户查询关键词匹配
  if (!artifactRepairMode && !shouldInjectArtifactBrief && !ctx.runtime.isSimpleTaskMode && userQuery) {
    try {
      const skills = await loadRelevantSkills(userQuery);
      const skillBlock = buildSkillInjectionBlock(skills);
      if (skillBlock) {
        systemPrompt = appendPromptBlockWithinBudget(systemPrompt, skillBlock, 'skills', ctx);
        if (systemPrompt.includes(skillBlock)) {
          appendedBlocks.set('skills', skillBlock);
        }
        logger.debug(
          `[ContextAssembly] Injected ${skills.length} relevant skill(s) into prompt`,
        );
      }
    } catch (err) {
      logger.debug(
        `[ContextAssembly] Skill injection skipped: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  // 注入 Repo Map（代码结构索引，借鉴 Aider）
  if (
    ctx.runtime.workingDirectory &&
    !ctx.runtime.isSimpleTaskMode &&
    REPO_MAP_INTENT_PATTERN.test(userQuery) &&
    !shouldInjectArtifactBrief &&
    !artifactRepairMode
  ) {
    try {
      const repoMapResult = await getRepoMap({
        rootDir: ctx.runtime.workingDirectory,
        tokenBudget: 1500,
      });
      if (repoMapResult.text) {
        const before = systemPrompt;
        systemPrompt = appendPromptBlockWithinBudget(
          systemPrompt,
          `<repo_map>\n${repoMapResult.text}\n</repo_map>`,
          'repo map',
          ctx,
        );
        if (systemPrompt !== before) {
          appendedBlocks.set('repo map', `<repo_map>\n${repoMapResult.text}\n</repo_map>`);
          logger.debug(`[ContextAssembly] RepoMap injected: ${repoMapResult.fileCount} files, ${repoMapResult.symbolCount} symbols, ~${repoMapResult.estimatedTokens} tokens`);
        }
      }
    } catch (err) {
      logger.debug(`[ContextAssembly] RepoMap skipped: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  // 注入近期对话摘要（跨会话连续性，借鉴 ChatGPT Layer 4）
  if (!artifactRepairMode && !shouldInjectArtifactBrief && RECENT_CONVERSATIONS_INTENT_PATTERN.test(userQuery)) {
    const recentConversationsBlock = await buildRecentConversationsBlock();
    const beforeRecentConversations = systemPrompt;
    systemPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      recentConversationsBlock,
      'recent conversations',
      ctx,
    );
    recordMemoryInjectionTrace({
      blockType: 'recent_conversations',
      trigger: 'recent_conversations_intent',
      chars: recentConversationsBlock?.length ?? 0,
      injected: Boolean(recentConversationsBlock) && systemPrompt !== beforeRecentConversations,
      source: 'recent-conversations',
      count: countTraceEntries(recentConversationsBlock),
      sessionId: ctx.runtime.sessionId,
    });
    if (recentConversationsBlock && systemPrompt.includes(recentConversationsBlock)) {
      appendedBlocks.set('recent conversations', recentConversationsBlock);
    }
  }

  // 按意图注入 Generative UI 能力说明（~700 tok）+ Design brief 收集规则（~250 tok）
  if (shouldInjectGenerativeUI && !shouldInjectArtifactBrief) {
    systemPrompt = appendPromptBlockWithinBudget(systemPrompt, GENERATIVE_UI_PROMPT, 'generative UI', ctx);
    if (systemPrompt.includes(GENERATIVE_UI_PROMPT)) {
      appendedBlocks.set('generative UI', GENERATIVE_UI_PROMPT);
    }
    // 同条件注入 question-form 规则——LLM 看到 design-brief reminder 时会按规则跳过 form。
    systemPrompt = appendPromptBlockWithinBudget(systemPrompt, QUESTION_FORM_PROMPT, 'question form', ctx);
    if (systemPrompt.includes(QUESTION_FORM_PROMPT)) {
      appendedBlocks.set('question form', QUESTION_FORM_PROMPT);
    }
    logger.debug('[ContextAssembly] GenerativeUI + QuestionForm prompts injected (intent matched)');
  }

  // 注入延迟工具提示
  if (!artifactRepairMode && !shouldInjectArtifactBrief && ctx.runtime.enableToolDeferredLoading) {
    const deferredToolsSummary = getDeferredToolsSummary();
    if (deferredToolsSummary) {
      const deferredToolsBlock = `<deferred-tools>
除了核心工具外，以下工具可通过 ToolSearch 发现和加载。当核心工具无法完成任务时（例如需要浏览器操作、截图、PPT/Excel 生成、图片分析等），你必须先用 ToolSearch 加载对应工具。

${deferredToolsSummary}

用法：ToolSearch("browser") 搜索浏览器工具 | ToolSearch("select:Browser") 直接加载
</deferred-tools>`;
      systemPrompt = appendPromptBlockWithinBudget(
        systemPrompt,
        deferredToolsBlock,
        'deferred tools',
        ctx,
      );
      if (systemPrompt.includes(deferredToolsBlock)) {
        appendedBlocks.set('deferred tools', deferredToolsBlock);
      }
    }
  }

  const tokens = estimateTokens(systemPrompt);
  if (tokens <= MAX_SYSTEM_PROMPT_TOKENS) {
    cache.dynamicPrompt = {
      key: cacheKey,
      createdAt: now,
      prompt: systemPrompt,
      tokens,
    };
  } else {
    cache.dynamicPrompt = undefined;
  }

  return systemPrompt;
}

function buildCompressionCacheKey(
  ctx: ContextAssemblyCtx,
  entries: ContextTranscriptEntry[],
  interventions: ContextInterventionSnapshot,
  contextWindowSize: number,
): string {
  const hash = createHash('sha256');
  hash.update(ctx.runtime.sessionId);
  hash.update('\u0000');
  hash.update(ctx.runtime.agentId || '');
  hash.update('\u0000');
  hash.update(String(contextWindowSize));
  hash.update('\u0000');
  hash.update(JSON.stringify(interventions));
  for (const entry of entries) {
    hash.update('\u0000');
    hash.update(entry.id);
    hash.update('\u0001');
    hash.update(entry.originMessageId);
    hash.update('\u0001');
    hash.update(entry.role);
    hash.update('\u0001');
    hash.update(String(entry.timestamp));
    hash.update('\u0001');
    hash.update(entry.content || '');
    hash.update('\u0001');
    hash.update(entry.toolCallId || '');
    hash.update('\u0001');
    hash.update(String(entry.toolError || false));
    if (entry.attachments?.length) {
      hash.update(JSON.stringify(entry.attachments.map((attachment) => ({
        type: attachment.type,
        name: attachment.name,
        path: attachment.path,
        mimeType: attachment.mimeType,
        dataLength: attachment.data?.length || 0,
      }))));
    }
    if (entry.toolCalls?.length) {
      hash.update(JSON.stringify(entry.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments || {},
      }))));
    }
  }
  return hash.digest('hex');
}

function cloneTranscriptEntries(entries: ContextTranscriptEntry[]): ContextTranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function cloneCompressionState(state: CompressionState): CompressionState {
  try {
    return CompressionState.deserialize(state.serialize());
  } catch {
    return new CompressionState();
  }
}

export async function buildModelMessages(ctx: ContextAssemblyCtx): Promise<ModelMessage[]> {
  ctx.flushHookMessageBuffer();

  const modelMessages: ModelMessage[] = [];
  const modelMessageSourceIds: string[] = [];

  let systemPrompt = await buildCachedDynamicSystemPrompt(ctx);
  const appendedBlocks = new Map<string, string>();

  // 注入活跃子代理上下文（Phase 3: 让主 Agent 感知当前 team 状态）
  const activeAgentBlock = buildActiveAgentContext();
  if (activeAgentBlock) {
    const nextPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      activeAgentBlock,
      'active agent context',
      ctx,
    );
    if (nextPrompt !== systemPrompt) {
      appendedBlocks.set('active agent context', activeAgentBlock);
      systemPrompt = nextPrompt;
    }
  }

  // 注入后台 agent 完成通知（Codex-style async notifications）
  const completionNotifications = drainCompletionNotifications();
  if (completionNotifications.length > 0) {
    const completionBlock = completionNotifications.join('\n');
    const nextPrompt = appendPromptBlockWithinBudget(
      systemPrompt,
      completionBlock,
      'completion notifications',
      ctx,
    );
    if (nextPrompt !== systemPrompt) {
      appendedBlocks.set('completion notifications', completionBlock);
      systemPrompt = nextPrompt;
    }
  }

  // 拼接持久化系统上下文（任务指导、模式 reminder 等）
  // 这些信息每轮推理都需要可见，而非作为消息历史被淹没
  const persistentSystemContext = ctx.getBudgetedPersistentSystemContext();
  const artifactRepairContext = getArtifactRepairContext(ctx);
  const artifactRepairContextSet = new Set(artifactRepairContext);
  for (let index = 0; index < persistentSystemContext.length; index += 1) {
    const contextBlock = persistentSystemContext[index];
    const repairContext = artifactRepairContextSet.has(contextBlock);
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      contextBlock,
      `persistent system context #${index + 1}`,
      appendedBlocks,
      ctx,
      repairContext
        ? { kind: 'required', trimCandidates: REQUIRED_REPAIR_TRIM_CANDIDATES }
        : { kind: 'optional' },
    );
    systemPrompt = result.prompt;
  }

  const artifactRepairFocusBlock = buildArtifactRepairFocusBlock(ctx, artifactRepairContext);
  if (artifactRepairFocusBlock) {
    const result = appendPromptBlockWithinBudgetWithStatus(
      systemPrompt,
      artifactRepairFocusBlock,
      'artifact repair focus',
      appendedBlocks,
      ctx,
      { kind: 'required', trimCandidates: REQUIRED_REPAIR_TRIM_CANDIDATES },
    );
    systemPrompt = result.prompt;
  }

  // Check system prompt length and warn if too long
  systemPrompt = trimPreambleBeforeRequiredArtifactBlock(systemPrompt, ctx);
  const trimmedSystemPromptTokens = estimateTokens(systemPrompt);
  if (trimmedSystemPromptTokens > MAX_SYSTEM_PROMPT_TOKENS) {
    logger.warn(`[AgentLoop] System prompt too long: ${trimmedSystemPromptTokens} tokens (limit: ${MAX_SYSTEM_PROMPT_TOKENS})`);
    logCollector.agent('WARN', 'System prompt exceeds recommended limit', {
      tokens: trimmedSystemPromptTokens,
      limit: MAX_SYSTEM_PROMPT_TOKENS,
    });
  }

  // Cache system prompt for eval center review + telemetry
  try {
    const hash = createHash('sha256').update(systemPrompt).digest('hex');
    ctx.runtime.currentSystemPromptHash = hash;
    getSystemPromptCache().store(hash, systemPrompt, trimmedSystemPromptTokens, 'gen8');
  } catch {
    // Non-critical: don't break agent loop if cache fails
  }

  modelMessages.push({
    role: 'system',
    content: systemPrompt,
  });
  modelMessageSourceIds.push('__system_prompt__');

  const interventionState = getContextInterventionState();
  const effectiveInterventions = interventionState.getEffectiveSnapshot(ctx.runtime.sessionId, ctx.runtime.agentId);
  const transcriptEntries = ctx.buildContextTranscriptEntries(ctx.runtime.messages);
  const transcriptInterventions = ctx.mapInterventionsToTranscriptEntries(
    effectiveInterventions,
    transcriptEntries,
  );
  const excludedTranscriptIds = new Set(transcriptInterventions.excluded);
  const interventionAdjustedEntries = applyInterventionsToMessages(
    transcriptEntries.filter((entry) => !excludedTranscriptIds.has(entry.id)),
    transcriptInterventions,
    transcriptEntries,
  );

  let contextApiView = interventionAdjustedEntries;
  const contextWindowSize = getContextWindow(ctx.runtime.modelConfig.model);
  try {
    const cache = getRuntimeAssemblyCache(ctx);
    const compressionCacheKey = buildCompressionCacheKey(
      ctx,
      interventionAdjustedEntries,
      transcriptInterventions,
      contextWindowSize,
    );
    const cachedCompression = cache.compression;
    const now = Date.now();

    if (
      cachedCompression?.key === compressionCacheKey &&
      now - cachedCompression.createdAt < COMPRESSION_CACHE_TTL_MS
    ) {
      ctx.runtime.compressionState = CompressionState.deserialize(cachedCompression.state);
      persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
      contextApiView = cloneTranscriptEntries(cachedCompression.apiView);
      logger.debug('[ContextAssembly] compression projection cache hit', {
        apiViewMessages: contextApiView.length,
      });
    } else {
      const nextCompressionState = cloneCompressionState(ctx.runtime.compressionState);
      const lastActivityAt = interventionAdjustedEntries.at(-1)?.timestamp ?? Date.now();
      const idleMinutes = Math.max(0, (Date.now() - lastActivityAt) / 60_000);
      const currentTurnIndex = interventionAdjustedEntries.reduce(
        (maxTurnIndex, entry) => Math.max(maxTurnIndex, entry.turnIndex),
        0,
      );

      const pipelineResult = await ctx.runtime.compressionPipeline.evaluate(
        interventionAdjustedEntries.map((entry) => ({ ...entry })),
        nextCompressionState,
        {
          maxTokens: contextWindowSize,
          currentTurnIndex,
          isMainThread: !ctx.runtime.agentId,
          cacheHot: idleMinutes < 2,
          idleMinutes,
          summarize: (messages) => ctx.summarizeCollapsedContext(messages),
          enableSnip: true,
          enableMicrocompact: true,
          enableContextCollapse: true,
          toolResultBudget: 2000,
          protectedToolResultPredicate: (entry) =>
            entry.role === 'tool' &&
            (entry as ContextTranscriptEntry).preserveObservation === true,
          interventions: transcriptInterventions,
        },
      );

      ctx.runtime.compressionState = nextCompressionState;
      persistRuntimeState(ctx.runtime, { compressionState: true, persistentSystemContext: false });
      contextApiView = pipelineResult.apiView as ContextTranscriptEntry[];
      cache.compression = {
        key: compressionCacheKey,
        createdAt: now,
        apiView: cloneTranscriptEntries(contextApiView),
        state: nextCompressionState.serialize(),
      };

      const entryIdToOriginMessageId = new Map(
        interventionAdjustedEntries.map((entry) => [entry.id, entry.originMessageId]),
      );
      getContextEventLedger().upsertCompressionEvents(
        ctx.runtime.sessionId,
        ctx.runtime.agentId,
        nextCompressionState.getCommitLog(),
        (messageId) => entryIdToOriginMessageId.get(messageId) ?? messageId,
      );

      const autocompactNeeded = pipelineResult.layersTriggered.includes('autocompact-needed');
      // P2-full/G12: 把 Pipeline 的压力信号交给 ContextPressureController（经
      // checkAndAutoCompress 消费），不再让它只停留在 log/trace。无条件写入，
      // false 也写，避免上一 turn 的 stale true 残留。
      ctx.runtime.pipelineAutocompactNeeded = autocompactNeeded;
      const commitCount = nextCompressionState.getCommitLog().length;
      if (commitCount > 0 || autocompactNeeded) {
        // G12/G20: 真正消费 pipeline 的报告 —— 此前 layersTriggered 只 logger.debug 就丢了，
        // autocompact-needed 是个静默死信号。现在落进结构化 turn trace，并对未执行的 L5 显式 warn。
        ctx.runtime.turnTrace.record('compaction', {
          layersTriggered: pipelineResult.layersTriggered,
          totalTokens: pipelineResult.totalTokens,
          commitCount,
          autocompactNeeded,
        });
        logger.debug('[ContextAssembly] Compression pipeline applied', {
          layersTriggered: pipelineResult.layersTriggered,
          commitCount,
          apiViewMessages: pipelineResult.apiView.length,
        });
        if (autocompactNeeded) {
          logger.warn(
            '[ContextAssembly] Pipeline reports autocompact-needed (usage ≥ 85%) — this path does not auto-execute L5; context stays hot until the AutoContextCompressor path triggers',
            { totalTokens: pipelineResult.totalTokens },
          );
        }
      }
    }
  } catch (error) {
    logger.error('[ContextAssembly] Compression pipeline evaluation failed, falling back to uncompressed transcript:', error);
    ctx.runtime.compressionState = new CompressionState();
  }

  // Allowlist 在循环内不变（只取决于 artifactRepairGuard），提到外面避免重复计算
  const REMOVED_TOOLS = new Set(['TodoWrite', 'todo_write']);
  const repairHistoryAllowlist = getArtifactRepairHistoryToolAllowlist(ctx);
  const repairHistoryAllowedToolCallIds = repairHistoryAllowlist
    ? getAllowedArtifactRepairToolCallIds(ctx, ctx.runtime.messages)
    : null;

  // 预扫:identify toolCallIds whose source assistant entry will drop them via allowlist filter.
  // 必须把对应的 tool message 也跳过,否则成 orphan tool — sanitizeToolCallOrder 会 demote 成 user,
  // 模型看到一堆"无主"的工具结果当成新指令,重复调用同一工具死循环。
  const filteredOutToolCallIds = new Set<string>();
  for (const entry of contextApiView) {
    if (entry.role !== 'assistant') continue;
    const tcEntry = entry as { toolCalls?: Array<{ id: string; name: string }>; content?: string };
    if (!tcEntry.toolCalls?.length) continue;
    const surviving = tcEntry.toolCalls.filter((tc) => {
      if (REMOVED_TOOLS.has(tc.name)) return false;
      if (!repairHistoryAllowlist) return true;
      return repairHistoryAllowedToolCallIds?.has(tc.id) ?? repairHistoryAllowlist.has(tc.name);
    });
    const survivingIds = new Set(surviving.map((tc) => tc.id));
    const willDropAssistant = surviving.length === 0 && !tcEntry.content;
    for (const tc of tcEntry.toolCalls) {
      if (willDropAssistant || !survivingIds.has(tc.id)) {
        filteredOutToolCallIds.add(tc.id);
      }
    }
  }

  logger.debug('[AgentLoop] Building model messages, total messages:', contextApiView.length);
  for (const entry of contextApiView) {
    logger.debug(` Message role=${entry.role}, hasAttachments=${!!entry.attachments?.length}, attachmentCount=${entry.attachments?.length || 0}`);

    if (entry.role === 'tool') {
      // 跳过 source assistant 已被 allowlist 过滤掉的 tool — 防止 orphan
      if (entry.toolCallId && filteredOutToolCallIds.has(entry.toolCallId)) {
        continue;
      }
      modelMessages.push({
        role: 'tool',
        content: entry.content,
        ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
        ...(entry.toolError ? { toolError: true } : {}),
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else if (entry.role === 'assistant' && entry.toolCalls?.length) {
      // 过滤掉已废弃工具的历史调用，避免模型从上下文中误判这些工具仍可用
      const tcs = entry.toolCalls.filter((tc) => {
        if (REMOVED_TOOLS.has(tc.name)) return false;
        if (!repairHistoryAllowlist) return true;
        return repairHistoryAllowedToolCallIds?.has(tc.id) ?? repairHistoryAllowlist.has(tc.name);
      });
      if (tcs.length === 0 && !entry.content) continue;
      modelMessages.push({
        role: 'assistant',
        content: entry.content || '',
        ...(tcs.length > 0 && {
          toolCalls: tcs.map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          })),
          toolCallText: tcs.map(tc => formatToolCallForHistory(tc)).join('\n'),
        }),
        thinking: entry.thinking,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else if (entry.role === 'user' && entry.attachments?.length) {
      const multimodalContent = buildMultimodalContent(entry.content, entry.attachments);
      modelMessages.push({
        role: 'user',
        content: multimodalContent,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    } else {
      modelMessages.push({
        role: entry.role,
        content: entry.content,
      });
      modelMessageSourceIds.push(entry.originMessageId);
    }
  }

  // Proactive compression check: trigger at 75% capacity to prevent hitting hard limits
  // 注意：maxTokens 是模型的最大输出限制，不是上下文窗口大小
  // 上下文窗口大小应该更大（如 64K-128K），这里使用保守估计 64000
  const currentTokens = estimateModelMessageTokens(modelMessages);
  if (ctx.runtime.messageHistoryCompressor.shouldProactivelyCompress(currentTokens, contextWindowSize)) {
    logger.info(`[AgentLoop] Proactive compression triggered: ${currentTokens}/${contextWindowSize} tokens (${Math.round(currentTokens / contextWindowSize * 100)}%)`);
    logCollector.agent('INFO', 'Proactive compression triggered', {
      currentTokens,
      maxTokens: contextWindowSize,
      usagePercent: Math.round(currentTokens / contextWindowSize * 100),
    });
  }

  return modelMessages;
}

export function buildContextTranscriptEntries(ctx: ContextAssemblyCtx, messages: Message[]): ContextTranscriptEntry[] {
  const artifactRepairMode = isArtifactRepairMode(ctx);
  const allowedArtifactRepairToolCallIds = artifactRepairMode
    ? getAllowedArtifactRepairToolCallIds(ctx, messages)
    : null;
  let turnIndex = 0;
  let hasSeenUserTurn = false;
  const entries: ContextTranscriptEntry[] = [];

  for (const message of messages) {
    if (message.role === 'user' && hasSeenUserTurn) {
      turnIndex += 1;
    }
    if (message.role === 'user') {
      hasSeenUserTurn = true;
    }

    const baseEntry = {
      originMessageId: message.id,
      timestamp: message.timestamp,
      turnIndex,
    };

    if (message.role === 'tool' && message.toolResults?.length) {
      entries.push(
      ...message.toolResults
          .filter((result) => {
            if (!allowedArtifactRepairToolCallIds) return true;
            if (!result.toolCallId) return true;
            const targetFile = getArtifactRepairTargetFile(ctx);
            const resultFilePath = typeof result.metadata?.filePath === 'string'
              ? result.metadata.filePath
              : null;
            if (result.metadata?.evidenceKind === 'file_read' && resultFilePath) {
              if (!targetFile) return false;
              return resolveArtifactRepairPath(ctx, resultFilePath) === targetFile && result.success === true;
            }
            const isTargetFileRead =
              result.metadata?.evidenceKind === 'file_read' &&
              resultFilePath &&
              targetFile &&
              resolveArtifactRepairPath(ctx, resultFilePath) === targetFile &&
              result.success === true;
            if (isTargetFileRead) return true;
            return allowedArtifactRepairToolCallIds.has(result.toolCallId);
          })
          .map((result, index) => ({
            ...baseEntry,
            id: `${message.id}::tool-result::${result.toolCallId || index}`,
            role: 'tool',
            content: artifactRepairMode
              ? formatArtifactRepairToolResultContent(ctx, result, result.output || result.error || '')
              : (result.output || result.error || ''),
            toolCallId: result.toolCallId,
            toolError: !result.success,
            preserveObservation: result.metadata?.preserveObservation === true,
            evidenceKind: typeof result.metadata?.evidenceKind === 'string' ? result.metadata.evidenceKind : undefined,
            filePath: typeof result.metadata?.filePath === 'string' ? result.metadata.filePath : undefined,
          })),
      );
      continue;
    }

    entries.push({
      ...baseEntry,
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
      ...(message.thinking ? { thinking: message.thinking } : {}),
    });
  }

  return entries;
}

export function mapInterventionsToTranscriptEntries(
  ctx: ContextAssemblyCtx,
  interventions: ContextInterventionSnapshot,
  entries: ContextTranscriptEntry[],
): ContextInterventionSnapshot {
  const entryIdsByOriginMessageId = new Map<string, string[]>();
  for (const entry of entries) {
    const entryIds = entryIdsByOriginMessageId.get(entry.originMessageId) || [];
    entryIds.push(entry.id);
    entryIdsByOriginMessageId.set(entry.originMessageId, entryIds);
  }

  const expandIds = (ids: string[]): string[] => {
    const expanded = new Set<string>();
    for (const id of ids) {
      const mappedIds = entryIdsByOriginMessageId.get(id);
      if (mappedIds && mappedIds.length > 0) {
        for (const mappedId of mappedIds) {
          expanded.add(mappedId);
        }
      } else {
        expanded.add(id);
      }
    }
    return Array.from(expanded);
  };

  return {
    pinned: expandIds(interventions.pinned),
    excluded: expandIds(interventions.excluded),
    retained: expandIds(interventions.retained),
  };
}

export async function summarizeCollapsedContext(
  ctx: ContextAssemblyCtx,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const prompt = [
    '请将下面这段运行上下文压缩成一段简洁摘要。',
    '要求：保留关键结论、文件路径、工具结果、失败原因和后续待办；不要编造；尽量控制在 200 tokens 内。',
    '',
    '上下文片段：',
    ...messages.map((message) => `[${message.role}] ${message.content}`),
  ].join('\n');

  try {
    return (await compactModelSummarize(prompt, 200)).trim();
  } catch (error) {
    logger.warn('[ContextAssembly] Context collapse summarization failed, using heuristic fallback', error);
    return messages
      .map((message) => `[${message.role}] ${message.content.replace(/\s+/g, ' ').trim()}`)
      .join(' | ')
      .slice(0, 1000);
  }
}

export function stripInternalFormatMimicry(ctx: ContextAssemblyCtx, content: string): string {
  if (!content) return content;
  let cleaned = content;
  // Remove "Ran: <command>" lines (model mimicking formatToolCallForHistory output)
  cleaned = cleaned.replace(/^Ran:\s+.+$/gm, '');
  // Remove "Tool results:" lines
  cleaned = cleaned.replace(/^Tool results:\s*$/gm, '');
  // Remove "[Compressed tool results: ...]" lines
  cleaned = cleaned.replace(/^\[Compressed tool results:.*?\]\s*$/gm, '');
  // Remove "<checkpoint-nudge ...>...</checkpoint-nudge>" blocks
  cleaned = cleaned.replace(/<checkpoint-nudge[^>]*>[\s\S]*?<\/checkpoint-nudge>/g, '');
  // Remove "<truncation-recovery>...</truncation-recovery>" blocks
  cleaned = cleaned.replace(/<truncation-recovery>[\s\S]*?<\/truncation-recovery>/g, '');
  // Collapse excessive blank lines left by removals
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

export function detectTaskPatterns(ctx: ContextAssemblyCtx, userMessage: string): string[] {
  const hints: string[] = [];
  const msg = userMessage.toLowerCase();

  // 异常检测任务 — 防止输出全部行
  if (/异常|anomal|outlier|离群/i.test(userMessage)) {
    hints.push(
      '【异常检测】输出文件只包含被标记为异常的行，不要输出全部数据。' +
      '使用 IQR 或 Z-score 方法检测，异常标记列用数值 0/1 或布尔值（不要用中文"是"/"否"字符串）。'
    );
  }

  // 透视表 + 交叉分析 — 防止遗漏子任务
  if (/透视|pivot|交叉分析/i.test(userMessage)) {
    hints.push(
      '【透视分析】此类任务通常包含多个子任务，务必逐项完成：' +
      '① 透视表 ② 排名/Top N ③ 增长率计算 ④ 图表 ⑤ 品类/分类占比数据。' +
      '每个子任务的结果保存为独立的 sheet 或文件。完成后对照检查是否有遗漏。'
    );
  }

  // 多轮迭代任务 — 防止上下文丢失
  if (ctx.runtime.messages.length > 10) {
    // This is a continuation turn in a multi-round session
    hints.push(
      '【多轮任务】这是多轮迭代任务。请先用 bash ls 检查输出目录中已有的文件，' +
      '在已有文件基础上修改，不要从头重建。图表修改请先读取数据源再重新生成。'
    );
  }

  return hints;
}

export function getCurrentAttachments(ctx: ContextAssemblyCtx): Array<{
  type: string;
  category?: string;
  name?: string;
  path?: string;
  data?: string;
  mimeType?: string;
}> {
  for (let i = ctx.runtime.messages.length - 1; i >= 0; i--) {
    const msg = ctx.runtime.messages[i];
    if (msg.role === 'user' && msg.attachments && msg.attachments.length > 0) {
      return msg.attachments.map(att => ({
        type: att.type,
        category: att.category,
        name: att.name,
        path: att.path,
        data: att.data,
        mimeType: att.mimeType,
      }));
    }
  }
  return [];
}
