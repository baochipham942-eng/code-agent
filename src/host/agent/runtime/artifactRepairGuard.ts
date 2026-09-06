import { isAbsolute, resolve, join } from 'path';
import type { RuntimeContext } from './runtimeContext';
import type { ArtifactRepairGuard, ArtifactRepairGuardPhase } from './artifactState';
import { inferArtifactRepairIssueCodesFromText } from './artifactRepairSpec';
import { getUserConfigDir } from '../../config/configPaths';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import { ARTIFACT_REPAIR_GUARD_SEED_MESSAGE_WINDOW } from '../../../shared/constants/repair';
import type { Message, ToolResult } from '../../../shared/contract';

export type { ArtifactRepairGuard };

// 设计草稿（Kun 借鉴：设计 tab）会话的工作目录在 app 托管的 .code-agent/design 下。
// 设计原型定义上不是游戏 artifact——这类会话整体豁免 artifact repair：既不进入、也
// 不被旧 guard 拦截、更不从历史文本里被重新种上 guard（dogfood 实测：旧 repair 状态
// 持久化进 DB 后会跨会话死锁拦截所有 Write，详见借鉴清单 Bug B）。
export function isDesignDraftWorkingDir(workingDirectory: string | null | undefined): boolean {
  if (!workingDirectory) return false;
  const designRoot = join(getUserConfigDir(), 'design');
  return isPathWithinRoot(workingDirectory, designRoot);
}

// Route A: the repair tool set never narrows by read/block counters.
// Pre-patch the model can Read/Edit/Write/Append AND Bash the target artifact:
// strong code models (e.g. deepseek) often want to inspect/build/test before
// editing, and blocking Bash pre-patch made them loop on the unavailable tool
// until the milestone retry was aborted (verified 2026-06-11 deepseek run).
// Enforcement matches (BC3): verification-style Bash (validator/test/typecheck/
// lint/build/compile) passes pre- and post-patch; source-read Bash stays blocked.
const ARTIFACT_REPAIR_PRE_PATCH_ALLOWLIST = new Set([
  'Read',
  'read_file',
  'Edit',
  'edit_file',
  'Write',
  'write_file',
  'Append',
  'append_file',
  'Bash',
  'bash',
]);

const ARTIFACT_REPAIR_POST_PATCH_ALLOWLIST = new Set([
  'Read',
  'read_file',
  'Edit',
  'edit_file',
  'Write',
  'write_file',
  'Append',
  'append_file',
  'Bash',
  'bash',
]);

const CANONICAL_TOOL_ORDER = ['Read', 'Edit', 'Write', 'Append', 'Bash'] as const;
const CANONICAL_MUTATION_TOOL_ORDER = ['Edit', 'Write', 'Append'] as const;

export interface ArtifactRepairToolPolicy {
  allowlist: ReadonlySet<string>;
  allowedToolNames: string[];
  allowedMutationToolNames: string[];
  mutationToolPrompt: string;
  mutationToolPromptZh: string;
  readAllowed: boolean;
  writeAllowed: boolean;
  bashAllowed: boolean;
  writePriority: boolean;
  fullRewritePriority: boolean;
  targetedReadAllowed: boolean;
  mutationOnly: boolean;
}

// Guard seed is source-gated, not wording-gated. Only our validator's
// delimited envelopes (and tool-result metadata.artifactValidation.failed)
// may plant repair mode. Generic words like 修复/错误/失败 in a Read document
// are noise even when they sit next to an .html path.
const ARTIFACT_VALIDATOR_FAILURE_ENVELOPE_PATTERN =
  /<artifact-(validation-failed(?:-history)?|playability-failed)\b[^>]*>([\s\S]*?)<\/artifact-\1>/gi;

const ARTIFACT_VALIDATOR_PASSED_ENVELOPE_PATTERN =
  /<artifact-validation-passed\b[^>]*>([\s\S]*?)<\/artifact-validation-passed>/gi;

const ARTIFACT_REPAIR_ENDED_ENVELOPE_PATTERN =
  /<(artifact-repair-degraded-release|force-final-response)\b[^>]*>([\s\S]*?)<\/\1>/gi;

// Branch 2 (no "target file:" prefix) must only match a real path prefix
// (`/`, `~/`, `./`, `../`) at a token boundary. The negative lookbehind stops it
// from latching onto a mid-token slash — e.g. matching `/foo.html` inside the
// bare relative path `games/foo.html`, which seeded the guard with a wrong path.
const ARTIFACT_TARGET_FILE_PATTERN =
  /(?:(?:target file|目标文件)\s*:\s*((?:(?:\/|~\/|\.{1,2}\/)[^\s"'`<>]+?|[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)\.html?)|((?<![A-Za-z0-9_.@/~:-])(?:\/|~\/|\.{1,2}\/)[^\s"'`<>]+?\.html?))(?=$|[\s"'`<>),;.，。])/gi;

function normalizeCandidatePath(rawPath: string): string {
  return rawPath.trim().replace(/[),;，。]+$/g, '');
}

export function resolveArtifactRepairPath(ctx: RuntimeContext, filePath: string): string {
  return isAbsolute(filePath)
    ? filePath
    : resolve(ctx.workingDirectory || process.cwd(), filePath);
}

export function isSameArtifactRepairPath(ctx: RuntimeContext, candidate: string, target: string): boolean {
  return resolveArtifactRepairPath(ctx, candidate) === target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractValidatorFailureEnvelopes(text: string): string[] {
  return [...text.matchAll(new RegExp(ARTIFACT_VALIDATOR_FAILURE_ENVELOPE_PATTERN, 'gi'))]
    .map((match) => match[0])
    .filter(Boolean);
}

function extractHtmlArtifactPathFromTrustedText(ctx: RuntimeContext, text: string): string | null {
  ARTIFACT_TARGET_FILE_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(ARTIFACT_TARGET_FILE_PATTERN)]
    .map((match) => normalizeCandidatePath(match[1] || match[2] || ''))
    .filter(Boolean)
    // 防御：网搜结果里的 URL（`https://host/x.html` 或带空格的 `: //host/x.html`）
    // 不是本地工件，绝不能当 repair 目标——否则 guard 锁死一个写不进去的 phantom
    // 路径，后续每个工具都被闸拦（2026-06-25 dogfood：CSDN 链接导致无限死锁）。
    .filter((candidate) => !candidate.startsWith('//') && !candidate.includes('://'));

  if (matches.length === 0) {
    return null;
  }

  return resolveArtifactRepairPath(ctx, matches[0]);
}

function extractArtifactRepairTargetFromText(ctx: RuntimeContext, text: string): string | null {
  const envelopes = extractValidatorFailureEnvelopes(text);
  for (const envelope of envelopes) {
    const targetFile = extractHtmlArtifactPathFromTrustedText(ctx, envelope);
    if (targetFile) return targetFile;
  }
  return null;
}

function extractTargetFromValidatorFailedToolResult(
  ctx: RuntimeContext,
  result: { metadata?: Record<string, unknown>; error?: string; output?: string },
): string | null {
  const metadata = result.metadata;
  if (!isRecord(metadata)) return null;
  const validation = metadata.artifactValidation;
  if (!isRecord(validation) || validation.failed !== true) return null;

  const rollback = metadata.artifactRepairRollback;
  if (isRecord(rollback) && typeof rollback.targetFile === 'string' && rollback.targetFile.length > 0) {
    return resolveArtifactRepairPath(ctx, rollback.targetFile);
  }

  const trustedText = [result.error, result.output]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return extractArtifactRepairTargetFromText(ctx, trustedText)
    ?? extractHtmlArtifactPathFromTrustedText(ctx, trustedText);
}

function extractDelimitedEnvelopes(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(new RegExp(pattern, 'gi'))]
    .map((match) => match[0])
    .filter(Boolean);
}

function extractValidatorPassedEnvelopes(text: string): string[] {
  return extractDelimitedEnvelopes(text, ARTIFACT_VALIDATOR_PASSED_ENVELOPE_PATTERN);
}

function extractRepairEndedEnvelopes(text: string): string[] {
  return extractDelimitedEnvelopes(text, ARTIFACT_REPAIR_ENDED_ENVELOPE_PATTERN)
    .filter((envelope) => (
      /reason="artifact-repair-tool-admission"/i.test(envelope)
      || /<artifact-repair-degraded-release\b/i.test(envelope)
    ));
}

function extractTargetFromValidatorPassedToolResult(
  ctx: RuntimeContext,
  result: { metadata?: Record<string, unknown>; error?: string; output?: string },
): string | null {
  const metadata = result.metadata;
  if (!isRecord(metadata)) return null;
  const validation = metadata.artifactValidation;
  if (!isRecord(validation) || validation.failed !== false || validation.crashed === true) {
    return null;
  }

  const rollback = metadata.artifactRepairRollback;
  if (isRecord(rollback) && typeof rollback.targetFile === 'string' && rollback.targetFile.length > 0) {
    return resolveArtifactRepairPath(ctx, rollback.targetFile);
  }

  const trustedText = [result.error, result.output]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return extractHtmlArtifactPathFromTrustedText(ctx, trustedText);
}

type LiveRepairFailure = { targetFile: string; sourceText: string };

function joinToolResultSourceText(
  result: { error?: string; output?: string },
  messageContent: unknown,
): string {
  return [result.error, result.output, messageContent]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function collectLiveArtifactRepairFailures(
  ctx: RuntimeContext,
  items: Array<Pick<Message, 'role'> & { content?: unknown; toolResults?: ToolResult[] }>,
): LiveRepairFailure[] {
  const live = new Map<string, LiveRepairFailure>();
  const recency: string[] = [];

  const recordFailure = (targetFile: string, sourceText: string): void => {
    live.set(targetFile, { targetFile, sourceText });
    const existing = recency.indexOf(targetFile);
    if (existing >= 0) recency.splice(existing, 1);
    recency.push(targetFile);
  };

  const resolveTarget = (targetFile: string): void => {
    live.delete(targetFile);
    const existing = recency.indexOf(targetFile);
    if (existing >= 0) recency.splice(existing, 1);
  };

  const resolveLatestOpenFailure = (): void => {
    const latest = recency.pop();
    if (latest) live.delete(latest);
  };

  const resolveFromTrustedText = (text: string): void => {
    const envelopes = [
      ...extractValidatorPassedEnvelopes(text),
      ...extractRepairEndedEnvelopes(text),
    ];
    if (envelopes.length === 0) return;
    for (const envelope of envelopes) {
      const targetFile = extractHtmlArtifactPathFromTrustedText(ctx, envelope);
      if (targetFile) resolveTarget(targetFile);
      else resolveLatestOpenFailure();
    }
  };

  for (const item of items) {
    if (item.role === 'tool') {
      for (const result of item.toolResults ?? []) {
        const failedTarget = extractTargetFromValidatorFailedToolResult(ctx, result);
        if (failedTarget) {
          recordFailure(failedTarget, joinToolResultSourceText(result, item.content));
          continue;
        }
        const passedTarget = extractTargetFromValidatorPassedToolResult(ctx, result);
        if (passedTarget) resolveTarget(passedTarget);
      }
      continue;
    }

    if (item.role !== 'system' || typeof item.content !== 'string') continue;

    if (extractValidatorFailureEnvelopes(item.content).length > 0) {
      const targetFile = extractArtifactRepairTargetFromText(ctx, item.content);
      if (targetFile) recordFailure(targetFile, item.content);
    }
    resolveFromTrustedText(item.content);
  }

  return recency
    .slice()
    .reverse()
    .map((targetFile) => live.get(targetFile))
    .filter((entry): entry is LiveRepairFailure => entry != null);
}

function inferArtifactRepairPhase(text: string): ArtifactRepairGuardPhase {
  if (/<artifact-playability-failed\b/i.test(text)) {
    return 'playability_repair';
  }
  if (/repair phase:\s*playability_repair\b/i.test(text)) {
    return 'playability_repair';
  }
  if (/\b(playability|playable|interaction|interactive|feel|controls?|visual)\b|体验|可玩性|不好玩|不能玩|玩不通|没法|无法|不能|上不去|拿不到|触发不了|手感|视觉|交互/i.test(text)) {
    return 'playability_repair';
  }
  return 'initial_repair';
}

function trySeedArtifactRepairGuard(
  ctx: RuntimeContext,
  targetFile: string,
  sourceText: string,
  activeIssueCodes: string[],
): boolean {
  if (
    ctx.artifact.validationPassedTargetFile
    && isSameArtifactRepairPath(ctx, targetFile, ctx.artifact.validationPassedTargetFile)
  ) {
    return false;
  }
  const issueCodes = inferArtifactRepairIssueCodesFromText(sourceText);
  ctx.artifact.setRepairGuard({
    targetFile,
    attempts: 0,
    phase: issueCodes.length > 0 ? 'initial_repair' : inferArtifactRepairPhase(sourceText),
    patched: false,
    ...(activeIssueCodes.length > 0 ? { activeIssueCodes } : {}),
  });
  return true;
}

export function seedArtifactRepairGuardFromContext(ctx: RuntimeContext): void {
  // 设计草稿会话整体豁免：清除任何已存 guard，且不从历史文本里重新种上——
  // 防止持久化进 DB 的旧 repair 状态跨会话死锁拦截设计写入。
  if (isDesignDraftWorkingDir(ctx.workingDirectory)) {
    ctx.artifact.clearRepairGuard();
    return;
  }
  if (ctx.artifact.repairGuard) return;

  const windowSize = ARTIFACT_REPAIR_GUARD_SEED_MESSAGE_WINDOW;
  const windowedMessages = (ctx.messages || []).slice(-windowSize);
  const windowedPersistent = (ctx.contextHealth?.persistentSystemContext || [])
    .filter((block): block is string => typeof block === 'string')
    .slice(-windowSize)
    .map((content) => ({ role: 'system' as const, content }));
  // Persistent blocks are older than the trailing message window. A later
  // pass/end envelope in messages must be able to retire those failures.
  const liveFailures = collectLiveArtifactRepairFailures(ctx, [
    ...windowedPersistent,
    ...windowedMessages,
  ]);

  const activeIssueCodes = [
    ...new Set(liveFailures.flatMap((entry) => inferArtifactRepairIssueCodesFromText(entry.sourceText))),
  ];

  for (const entry of liveFailures) {
    if (trySeedArtifactRepairGuard(ctx, entry.targetFile, entry.sourceText, activeIssueCodes)) {
      return;
    }
  }
}

// Route A: in repair mode the goal is always to write the fix, so the model is
// always in write-priority mode. Token caps and prompting use this directly;
// there is no longer a read-budget / blocked-tool gate that toggles it.
export function isArtifactRepairWritePriority(guard: ArtifactRepairGuard | undefined): boolean {
  return guard != null;
}

export function getArtifactRepairToolAllowlist(
  guard: ArtifactRepairGuard | undefined,
): ReadonlySet<string> {
  // Route A: only the patched/pre-patch split matters. The tool set never shrinks
  // based on read counts or blocked-tool counters.
  return guard?.patched
    ? ARTIFACT_REPAIR_POST_PATCH_ALLOWLIST
    : ARTIFACT_REPAIR_PRE_PATCH_ALLOWLIST;
}

function getCanonicalToolNames(allowlist: ReadonlySet<string>, order: readonly string[]): string[] {
  return order.filter((name) => allowlist.has(name));
}

function joinToolNames(names: string[], conjunction: 'or' | '或'): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  const head = names.slice(0, -1).join(conjunction === '或' ? '、' : ', ');
  return `${head}${conjunction === '或' ? ' 或 ' : ', or '}${names[names.length - 1]}`;
}

export function getArtifactRepairToolPolicy(
  guard: ArtifactRepairGuard | undefined,
): ArtifactRepairToolPolicy | null {
  if (!guard) return null;
  const allowlist = getArtifactRepairToolAllowlist(guard);
  const allowedToolNames = getCanonicalToolNames(allowlist, CANONICAL_TOOL_ORDER);
  const allowedMutationToolNames = getCanonicalToolNames(allowlist, CANONICAL_MUTATION_TOOL_ORDER);
  const mutationToolPrompt = joinToolNames(allowedMutationToolNames, 'or') || 'currently available file mutation tools';
  const mutationToolPromptZh = joinToolNames(allowedMutationToolNames, '或') || '当前可用的文件修改工具';
  const fullRewritePriority = isArtifactRepairWritePriority(guard)
    && (allowlist.has('Write') || allowlist.has('write_file'));

  return {
    allowlist,
    allowedToolNames,
    allowedMutationToolNames,
    mutationToolPrompt,
    mutationToolPromptZh,
    readAllowed: allowlist.has('Read') || allowlist.has('read_file'),
    writeAllowed: allowlist.has('Write') || allowlist.has('write_file'),
    bashAllowed: allowlist.has('Bash') || allowlist.has('bash'),
    writePriority: isArtifactRepairWritePriority(guard),
    fullRewritePriority,
    targetedReadAllowed: false,
    mutationOnly: false,
  };
}
