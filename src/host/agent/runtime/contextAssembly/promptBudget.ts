// ContextAssembly - system prompt 预算管理。
// 按模型动态解析 system prompt token 预算，并在预算内追加/裁剪 prompt 块。
// 从 messageBuild.ts 抽出以收敛文件体积，无行为变更（GAP-023 可见化逻辑保持原样）。

import { estimateTokens } from '../../../context/tokenOptimizer';
import {
  getContextEventLedger,
  type ContextEventLedger,
  type ContextEventRecord,
} from '../../../context/contextEventLedger';
import { CONTEXT_LEDGER } from '../../../../shared/constants';
import type { ContextAssemblyCtx } from './shared';
import { logger, getSystemPromptBudget } from './shared';

export type PromptAppendPolicy =
  | { kind: 'optional' }
  | { kind: 'required'; trimCandidates?: string[] };

interface PromptLayerBuffer {
  invocationId: string;
  nextSequence: number;
  records: Map<string, ContextEventRecord>;
}

const promptLayerBuffers = new WeakMap<object, PromptLayerBuffer>();

function getPromptLayerBuffer(ctx: ContextAssemblyCtx): PromptLayerBuffer | undefined {
  const invocationId = ctx.runtime.turn.currentTurnId;
  if (!invocationId) return undefined;
  const key = ctx.runtime as unknown as object;
  const existing = promptLayerBuffers.get(key);
  if (existing?.invocationId === invocationId) return existing;
  const created = { invocationId, nextSequence: 0, records: new Map<string, ContextEventRecord>() };
  promptLayerBuffers.set(key, created);
  return created;
}

function recordPromptLayer(
  ctx: ContextAssemblyCtx | undefined,
  label: string,
  chars: number,
  tokens: number,
  promptLayerOutcome: ContextEventRecord['promptLayerOutcome'],
): void {
  if (!ctx || !promptLayerOutcome) return;
  const buffer = getPromptLayerBuffer(ctx);
  if (!buffer) return;
  const existing = buffer.records.get(label);
  buffer.records.set(label, {
    id: '',
    sessionId: ctx.runtime.sessionId,
    agentId: ctx.runtime.agentId,
    invocationId: buffer.invocationId,
    sourceKind: CONTEXT_LEDGER.SOURCE_KIND.PROMPT_LAYER,
    sourceDetail: label,
    layer: label,
    reason: promptLayerOutcome,
    sequence: existing?.sequence ?? buffer.nextSequence++,
    chars,
    tokens,
    promptLayerOutcome,
    timestamp: Date.now(),
  });
}

export function recordBasePromptLayer(
  ctx: ContextAssemblyCtx,
  prompt: string,
  source: string,
  nestedBlocks: Iterable<string> = [],
): void {
  let substrate = prompt;
  for (const block of nestedBlocks) {
    substrate = removePromptBlock(substrate, block);
  }
  recordPromptLayer(
    ctx,
    source,
    substrate.length,
    estimateTokens(substrate),
    CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
  );
}

export function snapshotPromptLayerRecords(ctx: ContextAssemblyCtx): ContextEventRecord[] {
  const buffer = getPromptLayerBuffer(ctx);
  return buffer ? Array.from(buffer.records.values(), (record) => ({ ...record })) : [];
}

export function restorePromptLayerRecords(
  ctx: ContextAssemblyCtx,
  records: ReadonlyArray<ContextEventRecord>,
): void {
  const buffer = getPromptLayerBuffer(ctx);
  if (!buffer) return;
  for (const record of records) {
    const sequence = record.sequence ?? buffer.nextSequence;
    buffer.records.set(record.layer || record.sourceDetail || String(sequence), {
      ...record,
      id: '',
      sessionId: ctx.runtime.sessionId,
      agentId: ctx.runtime.agentId,
      invocationId: buffer.invocationId,
      sequence,
      timestamp: Date.now(),
    });
    buffer.nextSequence = Math.max(buffer.nextSequence, sequence + 1);
  }
}

export function flushPromptLayerRecords(
  ctx: ContextAssemblyCtx,
  ledger: Pick<ContextEventLedger, 'upsertEvents'> = getContextEventLedger(),
): ContextEventRecord[] {
  const buffer = getPromptLayerBuffer(ctx);
  if (!buffer) return [];
  const timestamp = Date.now();
  const records = Array.from(buffer.records.values(), (record) => ({ ...record, timestamp }));
  if (records.length > 0) ledger.upsertEvents(records);
  promptLayerBuffers.delete(ctx.runtime as unknown as object);
  return records;
}

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
  const dropped = ctx.runtime.contextHealth.droppedPromptBlocks;
  if (!dropped?.includes(label)) {
    ctx.runtime.contextHealth.recordDroppedPromptBlock(label);
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
    ctx?.runtime.stats.queueDiagnostic(
      `上下文预算跳过 ${label}：预计 ${nextTokens}/${promptBudget(ctx)} tokens`,
    );
    // GAP-023: 丢弃可见化（context health 面板），不只是 debug log
    recordDroppedPromptBlock(ctx, label);
    recordPromptLayer(
      ctx,
      label,
      block.length,
      estimateTokens(block),
      CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.DROPPED,
    );
    return prompt;
  }
  recordPromptLayer(
    ctx,
    label,
    nextPrompt.length - prompt.length,
    Math.max(0, nextTokens - estimateTokens(prompt)),
    CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
  );
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
    ctx?.runtime.stats.queueDiagnostic(
      `上下文预算保留必需 ${label}：预计 ${nextTokens}/${promptBudget(ctx)} tokens`,
    );
  }
  recordPromptLayer(
    ctx,
    label,
    nextPrompt.length - prompt.length,
    Math.max(0, nextTokens - estimateTokens(prompt)),
    CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.INCLUDED,
  );
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

/**
 * @param extraTokens 稳定前缀之外、同属本请求指令负载的 token 数（动态尾巴消息）。
 * 前缀稳定改造后 system 只承载稳定前缀，必需修复块走尾巴且允许超预算追加——
 * trim 判断必须按「稳定前缀 + 尾巴」合并口径，否则修复压力下 preamble 永远不裁（审计 A8）。
 */
export function trimPreambleBeforeRequiredArtifactBlock(
  prompt: string,
  ctx?: ContextAssemblyCtx,
  extraTokens = 0,
): string {
  if (estimateTokens(prompt) + extraTokens <= promptBudget(ctx)) return prompt;

  const markerMatch = /\n\n## Game Artifact (?:Repair )?Contract\b/.exec(prompt);
  if (!markerMatch || typeof markerMatch.index !== 'number' || markerMatch.index <= 0) return prompt;

  const suffix = prompt.slice(markerMatch.index);
  let prefix = prompt.slice(0, markerMatch.index);
  const trimNotice = '\n[base prompt trimmed to preserve required artifact contract]\n';

  while (prefix.length > 0 && estimateTokens(`${prefix}${trimNotice}${suffix}`) + extraTokens > promptBudget(ctx)) {
    const overflow = estimateTokens(`${prefix}${trimNotice}${suffix}`) + extraTokens - promptBudget(ctx);
    const removeChars = Math.max(240, overflow * 5);
    prefix = prefix.slice(0, Math.max(0, prefix.length - removeChars)).trimEnd();
  }

  const trimmedPrompt = `${prefix}${trimNotice}${suffix}`;
  if (estimateTokens(trimmedPrompt) + extraTokens <= promptBudget(ctx)) {
    ctx?.runtime.stats.queueDiagnostic('上下文预算压缩 base prompt：保留必需 game artifact contract');
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
    recordPromptLayer(
      ctx,
      candidate,
      candidateBlock.length,
      estimateTokens(candidateBlock),
      CONTEXT_LEDGER.PROMPT_LAYER_OUTCOME.TRIMMED,
    );
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
