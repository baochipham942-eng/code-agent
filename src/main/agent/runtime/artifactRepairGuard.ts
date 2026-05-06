import { isAbsolute, resolve } from 'path';
import type { RuntimeContext } from './runtimeContext';
import { inferArtifactRepairIssueCodesFromText } from './artifactRepairSpec';

const ARTIFACT_REPAIR_INTENT_PATTERN =
  /artifact[-_\s]*(validation|repair)|validation failed|validator\s*(失败|failed)|runSmokeTest|reachability|progressPlan|__INTERACTIVE_TEST__|__GAME_TEST__|交互测试合约|playability|playable|interaction|interactive|体验|可玩性|不好玩|不能玩|玩不通|没法|无法|不能|上不去|拿不到|触发不了|验收|验证/i;

const ARTIFACT_TARGET_FILE_PATTERN =
  /(?:(?:target file|目标文件)\s*:\s*)?((?:\/|~\/|\.{1,2}\/)?[^\s"'`<>]+?\.html?)(?=$|[\s"'`<>),;，。])/gi;

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
  if (!ARTIFACT_REPAIR_INTENT_PATTERN.test(text)) {
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

  const textBlocks: string[] = [];
  const messages = ctx.messages || [];
  for (let index = messages.length - 1; index >= 0 && textBlocks.length < 8; index -= 1) {
    const message = messages[index];
    if (typeof message?.content === 'string') {
      textBlocks.push(message.content);
    }
  }
  const persistentSystemContext = ctx.persistentSystemContext || [];
  for (let index = persistentSystemContext.length - 1; index >= 0 && textBlocks.length < 16; index -= 1) {
    textBlocks.push(persistentSystemContext[index]);
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
