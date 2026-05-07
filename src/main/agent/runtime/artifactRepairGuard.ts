import { isAbsolute, resolve } from 'path';
import type { RuntimeContext } from './runtimeContext';
import { inferArtifactRepairIssueCodesFromText } from './artifactRepairSpec';

const FULL_REWRITE_REPAIR_ISSUE_CODES = new Set([
  'missing_gameplay_mechanics',
  'gameplay_mechanics_without_runtime_evidence',
  'ability_gate_without_reachability',
]);

const ARTIFACT_REPAIR_CUE_PATTERN =
  /artifact[-_\s]*(?:validation\s*failed|repair)|validation failed|validator\s*(?:失败|failed)|(?:校验|验证)\s*失败|当前\s*(?:validator|校验|验证).*失败|修复|\b(?:repair|fix|failed|failure|missing|malformed)\b|未通过|失败|报错|缺少|no longer exposes|丢失|不能证明|无法证明|对象存在|机制注册|覆盖声明|直接授予|直接修改|宽松距离|测试模式修改|真实流程里获得|真实输入完成|玩不通|不能玩|不好玩|上不去|拿不到|触发不了/i;

const ARTIFACT_TARGET_FILE_PATTERN =
  /(?:(?:target file|目标文件)\s*:\s*)?((?:\/|~\/|\.{1,2}\/)?[^\s"'`<>]+?\.html?)(?=$|[\s"'`<>),;.，。])/gi;

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
  const hasRepairCue =
    ARTIFACT_REPAIR_CUE_PATTERN.test(text)
    || inferArtifactRepairIssueCodesFromText(text).length > 0;
  if (!hasRepairCue) {
    return null;
  }

  ARTIFACT_TARGET_FILE_PATTERN.lastIndex = 0;
  const matches = [...text.matchAll(ARTIFACT_TARGET_FILE_PATTERN)]
    .map((match) => normalizeCandidatePath(match[1] || ''))
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
      targetReadCount: 0,
      targetRangedReadCount: 0,
      patched: false,
      ...(activeIssueCodes.length > 0 ? { activeIssueCodes } : {}),
    };
    return;
  }
}

export function getArtifactRepairTargetReadBudget(
  guard: NonNullable<RuntimeContext['artifactRepairGuard']>,
): number {
  switch (guard.phase) {
    case 'read_then_patch':
    case 'targeted_repair':
    case 'initial_repair':
    case 'baseline_repair':
      return 1;
    default:
      return 1;
  }
}

export function getArtifactRepairTargetRangedReadBudget(
  guard: NonNullable<RuntimeContext['artifactRepairGuard']>,
): number {
  if (guard.patched) return 1;
  const issueCodes = guard.activeIssueCodes || [];
  if (issueCodes.includes('coverage_without_runtime_evidence') || issueCodes.includes('shortcut_state_mutation')) {
    return 2;
  }
  return 1;
}

export function shouldAllowFullArtifactRewriteDuringRepair(
  guard: NonNullable<RuntimeContext['artifactRepairGuard']>,
): boolean {
  if (guard.patched) return false;
  const issueCodes = guard.activeIssueCodes || [];
  if (issueCodes.some((code) => FULL_REWRITE_REPAIR_ISSUE_CODES.has(code))) {
    return true;
  }

  const attempts = guard.attempts ?? 0;
  const editAnchorFailures = guard.editAnchorFailureCount ?? 0;
  const noOpPatches = guard.noOpPatchCount ?? 0;

  if (attempts >= 3 && noOpPatches >= 1) return true;
  if (editAnchorFailures >= 1 && noOpPatches >= 1) return true;
  return false;
}
