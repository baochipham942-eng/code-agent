// ContextAssembly - system prompt 预算管理。
// 按模型动态解析 system prompt token 预算，并在预算内追加/裁剪 prompt 块。
// 从 messageBuild.ts 抽出以收敛文件体积，无行为变更（GAP-023 可见化逻辑保持原样）。

import { estimateTokens } from '../../../context/tokenOptimizer';
import type { ContextAssemblyCtx } from './shared';
import { logger, getSystemPromptBudget } from './shared';

export type PromptAppendPolicy =
  | { kind: 'optional' }
  | { kind: 'required'; trimCandidates?: string[] };

/**
 * GAP-023: 按当前模型解析 system prompt 预算（动态化）；无 ctx 时退回静态默认值。
 */
export function promptBudget(ctx?: ContextAssemblyCtx): number {
  return getSystemPromptBudget(ctx?.runtime.modelConfig?.model);
}

/**
 * GAP-023: 记录被预算丢弃/裁剪的 prompt 块（去重），供 context health 面板可见化。
 */
export function recordDroppedPromptBlock(ctx: ContextAssemblyCtx | undefined, label: string): void {
  if (!ctx) return;
  const dropped = (ctx.runtime.droppedPromptBlocks ??= []);
  if (!dropped.includes(label)) {
    dropped.push(label);
  }
}

export function appendPromptBlockWithinBudget(
  prompt: string,
  block: string | null | undefined,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (!block) return prompt;
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > promptBudget(ctx)) {
    logger.warn(`[ContextAssembly] Skipping ${label}: system prompt budget would be ${nextTokens}/${promptBudget(ctx)} tokens`);
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算跳过 ${label}：预计 ${nextTokens}/${promptBudget(ctx)} tokens`,
    );
    // GAP-023: 丢弃可见化（context health 面板），不只是 debug log
    recordDroppedPromptBlock(ctx, label);
    return prompt;
  }
  return nextPrompt;
}

export function appendRequiredPromptBlock(
  prompt: string,
  block: string,
  label: string,
  ctx?: ContextAssemblyCtx,
): string {
  const nextPrompt = `${prompt}\n\n${block}`;
  const nextTokens = estimateTokens(nextPrompt);
  if (nextTokens > promptBudget(ctx)) {
    logger.warn(
      `[ContextAssembly] Preserving required ${label}: system prompt budget is ${nextTokens}/${promptBudget(ctx)} tokens`,
    );
    ctx?.runtime.pendingRuntimeDiagnostics.push(
      `上下文预算保留必需 ${label}：预计 ${nextTokens}/${promptBudget(ctx)} tokens`,
    );
  }
  return nextPrompt;
}

export function removePromptBlock(prompt: string, block: string | null | undefined): string {
  if (!block) return prompt;
  const escapedBlock = block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return prompt
    .replace(new RegExp(`\\n\\n${escapedBlock}`), '')
    .replace(new RegExp(`^${escapedBlock}\\n\\n`), '')
    .replace(new RegExp(`^${escapedBlock}$`), '');
}

export function trimPreambleBeforeRequiredArtifactBlock(
  prompt: string,
  ctx?: ContextAssemblyCtx,
): string {
  if (estimateTokens(prompt) <= promptBudget(ctx)) return prompt;

  const markerMatch = /\n\n## Game Artifact (?:Repair )?Contract\b/.exec(prompt);
  if (!markerMatch || typeof markerMatch.index !== 'number' || markerMatch.index <= 0) return prompt;

  const suffix = prompt.slice(markerMatch.index);
  let prefix = prompt.slice(0, markerMatch.index);
  const trimNotice = '\n[base prompt trimmed to preserve required artifact contract]\n';

  while (prefix.length > 0 && estimateTokens(`${prefix}${trimNotice}${suffix}`) > promptBudget(ctx)) {
    const overflow = estimateTokens(`${prefix}${trimNotice}${suffix}`) - promptBudget(ctx);
    const removeChars = Math.max(240, overflow * 5);
    prefix = prefix.slice(0, Math.max(0, prefix.length - removeChars)).trimEnd();
  }

  const trimmedPrompt = `${prefix}${trimNotice}${suffix}`;
  if (estimateTokens(trimmedPrompt) <= promptBudget(ctx)) {
    ctx?.runtime.pendingRuntimeDiagnostics.push('上下文预算压缩 base prompt：保留必需 game artifact contract');
    return trimmedPrompt;
  }

  return prompt;
}

export function appendPromptBlockWithinBudgetWithStatus(
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
    // GAP-023: 为保必需块而被裁掉的块同样可见化
    recordDroppedPromptBlock(ctx, candidate);
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

export const REQUIRED_REPAIR_TRIM_CANDIDATES = [
  'repo map',
  'skills',
  'recent conversations',
  'deferred tools',
  'generative UI',
  'question form',
  'active agent context',
  'completion notifications',
];
