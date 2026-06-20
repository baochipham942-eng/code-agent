import { isAbsolute, resolve, join } from 'path';
import type { RuntimeContext } from './runtimeContext';
import { inferArtifactRepairIssueCodesFromText } from './artifactRepairSpec';
import { getUserConfigDir } from '../../config/configPaths';

// 设计草稿（Kun 借鉴：设计 tab）会话的工作目录在 app 托管的 .code-agent/design 下。
// 设计原型定义上不是游戏 artifact——这类会话整体豁免 artifact repair：既不进入、也
// 不被旧 guard 拦截、更不从历史文本里被重新种上 guard（dogfood 实测：旧 repair 状态
// 持久化进 DB 后会跨会话死锁拦截所有 Write，详见借鉴清单 Bug B）。
export function isDesignDraftWorkingDir(workingDirectory: string | null | undefined): boolean {
  if (!workingDirectory) return false;
  const designRoot = join(getUserConfigDir(), 'design');
  return workingDirectory === designRoot || workingDirectory.startsWith(`${designRoot}/`);
}

// Route A: the repair tool set never narrows by read/block counters.
// Pre-patch the model can Read/Edit/Write/Append AND Bash the target artifact:
// strong code models (e.g. deepseek) often want to inspect/build/test before
// editing, and blocking Bash pre-patch made them loop on the unavailable tool
// until the milestone retry was aborted (verified 2026-06-11 deepseek run).
// Bash here is the same workspace-scoped tool already allowed post-patch.
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

type ArtifactRepairGuard = NonNullable<RuntimeContext['artifactRepairGuard']>;

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

const EXPLICIT_ARTIFACT_REPAIR_INTENT_PATTERN =
  /artifact[-_\s]*(?:validation\s*failed|repair)|<artifact[-_\s]*(?:repair|validation)|\b(?:repair|fix|patch|correct|restore)\b|修复|修正|改好|补丁|继续修/i;

const ARTIFACT_REPAIR_VALIDATION_CONTEXT_PATTERN =
  /artifact validation failed|game artifact validation failed|validator\s*(?:失败|failed)|validation\s*(?:failed|failure)|(?:校验|验证|验收)\s*(?:失败|未通过|不通过)|runSmokeTest|__GAME_TEST__|__INTERACTIVE_TEST__|\b(?:missing|malformed)\b|报错|错误|缺少|no longer exposes|丢失|不能证明|无法证明|对象存在|机制注册|覆盖声明|直接授予|直接修改|宽松距离|测试模式修改|真实流程里获得|真实输入完成|玩不通|不能玩|不好玩|上不去|拿不到|触发不了/i;

// Branch 2 (no "target file:" prefix) must only match a real path prefix
// (`/`, `~/`, `./`, `../`) at a token boundary. The negative lookbehind stops it
// from latching onto a mid-token slash — e.g. matching `/foo.html` inside the
// bare relative path `games/foo.html`, which seeded the guard with a wrong path.
const ARTIFACT_TARGET_FILE_PATTERN =
  /(?:(?:target file|目标文件)\s*:\s*((?:(?:\/|~\/|\.{1,2}\/)[^\s"'`<>]+?|[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)\.html?)|((?<![A-Za-z0-9_.@/~-])(?:\/|~\/|\.{1,2}\/)[^\s"'`<>]+?\.html?))(?=$|[\s"'`<>),;.，。])/gi;

const RUNTIME_ARTIFACT_REPAIR_CONTEXT_PATTERN =
  /<artifact[-_\s]*(?:repair|validation)|artifact validation failed|game artifact validation failed|artifact repair mode is active/i;

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

function extractArtifactRepairTargetFromText(ctx: RuntimeContext, text: string): string | null {
  const issueCodes = inferArtifactRepairIssueCodesFromText(text);
  const hasRepairIntent = EXPLICIT_ARTIFACT_REPAIR_INTENT_PATTERN.test(text);
  const hasValidationContext =
    ARTIFACT_REPAIR_VALIDATION_CONTEXT_PATTERN.test(text)
    || issueCodes.length > 0;
  if (!hasRepairIntent || !hasValidationContext) {
    return null;
  }

  ARTIFACT_TARGET_FILE_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(ARTIFACT_TARGET_FILE_PATTERN)]
    .map((match) => normalizeCandidatePath(match[1] || match[2] || ''))
    .filter(Boolean);

  if (matches.length === 0) {
    return null;
  }

  return resolveArtifactRepairPath(ctx, matches[0]);
}

function isRuntimeArtifactRepairContext(text: string): boolean {
  return RUNTIME_ARTIFACT_REPAIR_CONTEXT_PATTERN.test(text);
}

function inferArtifactRepairPhase(text: string): string {
  if (/<artifact-playability-failed\b/i.test(text)) {
    return 'playability_repair';
  }
  if (/\b(playability|playable|interaction|interactive|feel|controls?|visual)\b|体验|可玩性|不好玩|不能玩|玩不通|没法|无法|不能|上不去|拿不到|触发不了|手感|视觉|交互/i.test(text)) {
    return 'playability_repair';
  }
  return 'initial_repair';
}

export function seedArtifactRepairGuardFromContext(ctx: RuntimeContext): void {
  // 设计草稿会话整体豁免：清除任何已存 guard，且不从历史文本里重新种上——
  // 防止持久化进 DB 的旧 repair 状态跨会话死锁拦截设计写入。
  if (isDesignDraftWorkingDir(ctx.workingDirectory)) {
    ctx.artifactRepairGuard = undefined;
    return;
  }
  if (ctx.artifactRepairGuard) return;

  const messageTextBlocks: string[] = [];
  const messages = ctx.messages || [];
  for (let index = messages.length - 1; index >= 0 && messageTextBlocks.length < 8; index -= 1) {
    const message = messages[index];
    if (typeof message?.content === 'string') {
      messageTextBlocks.push(message.content);
    }
  }

  const textBlocks = [...messageTextBlocks];
  const persistentSystemContext = ctx.persistentSystemContext || [];
  for (let index = persistentSystemContext.length - 1; index >= 0 && textBlocks.length < 16; index -= 1) {
    const block = persistentSystemContext[index];
    if (typeof block !== 'string' || !isRuntimeArtifactRepairContext(block)) continue;
    textBlocks.push(block);
  }

  const activeIssueCodes = [
    ...new Set(textBlocks.flatMap((text) => inferArtifactRepairIssueCodesFromText(text))),
  ];

  for (const text of textBlocks) {
    const targetFile = extractArtifactRepairTargetFromText(ctx, text);
    if (!targetFile) continue;
    const issueCodes = inferArtifactRepairIssueCodesFromText(text);
    ctx.artifactRepairGuard = {
      targetFile,
      attempts: 0,
      phase: issueCodes.length > 0 ? 'initial_repair' : inferArtifactRepairPhase(text),
      patched: false,
      ...(activeIssueCodes.length > 0 ? { activeIssueCodes } : {}),
    };
    return;
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
