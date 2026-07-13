import type { ModelProvider } from '../../../shared/contract/model';
import type {
  MemoryPackResult,
  PackedMemoryItem,
} from '../../../shared/contract/memory';
import type {
  TurnQualityMemoryBlock,
  TurnQualityMemorySummary,
  TurnQualityScoreBreakdown,
  TurnQualityScoreSummary,
  TurnQualitySummary,
} from '../../../shared/contract/turnQuality';
import type { MessageMetadata } from '../../../shared/contract/message';
import type { ModelResponse } from '../loopTypes';
import type { RuntimeContext } from './runtimeContext';

/** 2d: turn quality run 级记忆（ADR-038 批2d，owner=turnQuality） */
export interface TurnQualityRunState { memory?: TurnQualityMemorySummary; }

const MAX_VISIBLE_MEMORY_ITEMS = 6;
const MAX_PREVIEW_CHARS = 220;
const MAX_SCORE_REASONS = 4;
const MAX_EVIDENCE_ITEMS = 3;

function previewText(value: string | undefined): string | undefined {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_PREVIEW_CHARS
    ? `${text.slice(0, MAX_PREVIEW_CHARS - 3)}...`
    : text;
}

function ensureTurnMemory(ctx: RuntimeContext): TurnQualityMemorySummary {
  if (!ctx.turnQualityState.memory) {
    ctx.turnQualityState.memory = {
      mode: ctx.memoryMode ?? 'auto',
      blocks: [],
      suppressedEntryIds: ctx.suppressedMemoryEntryIds?.length
        ? [...ctx.suppressedMemoryEntryIds]
        : undefined,
    };
  }
  return ctx.turnQualityState.memory;
}

function mapPackedMemoryItem(item: PackedMemoryItem) {
  return {
    entryId: item.entryId,
    title: item.title,
    kind: item.kind,
    scope: item.scope,
    status: item.status,
    score: item.score,
    scoreReasons: item.scoreReasons.slice(0, MAX_SCORE_REASONS),
    source: item.source,
    evidence: item.evidence.slice(0, MAX_EVIDENCE_ITEMS),
    preview: previewText(item.content),
    truncated: item.truncated,
  };
}

export function recordTurnMemoryDisabled(ctx: RuntimeContext, offReason: string): void {
  ctx.turnQualityState.memory = {
    mode: 'off',
    blocks: [],
    suppressedEntryIds: ctx.suppressedMemoryEntryIds?.length
      ? [...ctx.suppressedMemoryEntryIds]
      : undefined,
    offReason,
  };
}

export function recordTurnMemoryBlock(
  ctx: RuntimeContext,
  block: TurnQualityMemoryBlock,
): void {
  const memory = ensureTurnMemory(ctx);
  memory.mode = ctx.memoryMode ?? memory.mode;
  memory.suppressedEntryIds = ctx.suppressedMemoryEntryIds?.length
    ? [...ctx.suppressedMemoryEntryIds]
    : undefined;
  memory.blocks.push(block);
}

export function recordPackedSeedMemory(
  ctx: RuntimeContext,
  params: {
    block: string;
    packed: MemoryPackResult;
    injected: boolean;
    source: string;
  },
): void {
  recordTurnMemoryBlock(ctx, {
    blockType: 'seed-memory',
    trigger: 'session_start',
    source: params.source,
    injected: params.injected,
    chars: params.block.length,
    count: params.packed.items.length,
    selectedCount: params.packed.selectedCount,
    totalCandidates: params.packed.totalCandidates,
    budget: params.packed.budget,
    items: params.packed.items.slice(0, MAX_VISIBLE_MEMORY_ITEMS).map(mapPackedMemoryItem),
  });
}

function uniqueStrings(values: string[]): string[] | undefined {
  const unique = Array.from(new Set(values.filter(Boolean)));
  return unique.length > 0 ? unique : undefined;
}

function scoreStatus(score: number, max: number): TurnQualityScoreBreakdown['status'] {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 0.8) return 'good';
  if (ratio >= 0.55) return 'watch';
  return 'risk';
}

function scoreGrade(score: number, max: number): TurnQualityScoreSummary['grade'] {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 0.9) return 'excellent';
  if (ratio >= 0.75) return 'good';
  if (ratio >= 0.55) return 'watch';
  return 'risk';
}

function clampScore(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

function buildScoreBreakdown(params: {
  memory: TurnQualityMemorySummary;
  strategyDecisionReason?: string;
  strategyProfile?: string;
  toolsUsed?: string[];
  warnings?: string[];
  response?: ModelResponse;
}): TurnQualityScoreSummary {
  const injectedMemoryBlocks = params.memory.blocks.filter((block) => block.injected);
  const visibleMemoryItems = injectedMemoryBlocks.reduce((sum, block) => sum + (block.items?.length || block.count || 0), 0);
  const warnings = params.warnings || [];
  const toolsUsed = params.toolsUsed || [];
  const breakdown: TurnQualityScoreBreakdown[] = [];

  const strategyReasons: string[] = [];
  let strategyScore = 14;
  if (params.strategyProfile) {
    strategyScore += 6;
    strategyReasons.push(`命中 ${params.strategyProfile} 策略`);
  }
  if (params.strategyDecisionReason === 'fallback-availability') {
    strategyScore -= 6;
    strategyReasons.push('策略目标模型不可用并回退');
  } else if (params.strategyDecisionReason) {
    strategyReasons.push(`路由原因 ${params.strategyDecisionReason}`);
  }
  breakdown.push({
    dimension: 'strategy',
    score: clampScore(strategyScore, 20),
    max: 20,
    status: scoreStatus(strategyScore, 20),
    reasons: strategyReasons.length ? strategyReasons : ['使用当前模型配置'],
  });

  const memoryReasons: string[] = [];
  let memoryScore = params.memory.mode === 'off' ? 8 : 12;
  if (params.memory.mode === 'off') {
    memoryReasons.push(params.memory.offReason || '本轮关闭记忆');
  } else if (visibleMemoryItems > 0) {
    memoryScore += 8;
    memoryReasons.push(`注入 ${visibleMemoryItems} 条可见记忆`);
  } else if (injectedMemoryBlocks.length > 0) {
    memoryScore += 4;
    memoryReasons.push(`注入 ${injectedMemoryBlocks.length} 个记忆块`);
  } else {
    memoryReasons.push('未命中可见记忆');
  }
  if (params.memory.suppressedEntryIds?.length) {
    memoryScore += 2;
    memoryReasons.push(`本会话忽略 ${params.memory.suppressedEntryIds.length} 条记忆`);
  }
  breakdown.push({
    dimension: 'memory',
    score: clampScore(memoryScore, 20),
    max: 20,
    status: scoreStatus(memoryScore, 20),
    reasons: memoryReasons,
  });

  const toolingReasons: string[] = [];
  let toolingScore = 12;
  if (toolsUsed.length > 0) {
    toolingScore += 6;
    toolingReasons.push(`使用 ${toolsUsed.length} 个工具`);
  } else {
    toolingReasons.push('本轮无工具调用');
  }
  breakdown.push({
    dimension: 'tooling',
    score: clampScore(toolingScore, 20),
    max: 20,
    status: scoreStatus(toolingScore, 20),
    reasons: toolingReasons,
  });

  const capabilityReasons: string[] = [];
  let capabilityScore = 14;
  if (params.response?.fallback) {
    capabilityScore -= 4;
    capabilityReasons.push(`发生模型 fallback: ${params.response.fallback.category}`);
  } else {
    capabilityReasons.push('未发生能力 fallback');
  }
  breakdown.push({
    dimension: 'capability',
    score: clampScore(capabilityScore, 20),
    max: 20,
    status: scoreStatus(capabilityScore, 20),
    reasons: capabilityReasons,
  });

  const deliveryReasons: string[] = [];
  let deliveryScore = 20;
  if (warnings.length) {
    deliveryScore -= Math.min(12, warnings.length * 4);
    deliveryReasons.push(`${warnings.length} 条运行警告`);
  } else {
    deliveryReasons.push('无运行警告');
  }
  breakdown.push({
    dimension: 'delivery',
    score: clampScore(deliveryScore, 20),
    max: 20,
    status: scoreStatus(deliveryScore, 20),
    reasons: deliveryReasons,
  });

  const total = breakdown.reduce((sum, item) => sum + item.score, 0);
  const max = breakdown.reduce((sum, item) => sum + item.max, 0);
  return {
    score: total,
    max,
    grade: scoreGrade(total, max),
    breakdown,
  };
}

export function buildTurnQualitySummary(
  ctx: RuntimeContext,
  response?: ModelResponse,
): TurnQualitySummary {
  const memory = ensureTurnMemory(ctx);
  const provider = (response?.actualProvider || ctx.modelConfig.provider) as ModelProvider;
  const model = response?.actualModel || ctx.modelConfig.model;
  const warnings = uniqueStrings([
    ...(ctx.droppedPromptBlocks?.length
      ? [`Prompt blocks dropped: ${ctx.droppedPromptBlocks.join(', ')}`]
      : []),
    ...(ctx.pendingRuntimeDiagnostics || []),
  ]);
  const toolsUsed = uniqueStrings(ctx.toolsUsedInTurn || []);
  const decision = ctx.turnModelDecision;
  const score = buildScoreBreakdown({
    memory,
    strategyDecisionReason: decision?.reason,
    strategyProfile: decision?.strategyProfile,
    toolsUsed,
    warnings,
    response,
  });

  return {
    memory: {
      ...memory,
      blocks: [...memory.blocks],
      suppressedEntryIds: memory.suppressedEntryIds ? [...memory.suppressedEntryIds] : undefined,
    },
    strategy: {
      provider,
      model,
      requestedProvider: (decision?.requestedProvider || ctx.modelConfig.provider) as ModelProvider,
      requestedModel: decision?.requestedModel || ctx.modelConfig.model,
      adaptive: ctx.modelConfig.adaptive,
      effortLevel: ctx.effortLevel,
      profile: decision?.strategyProfile,
      ruleId: decision?.strategyRuleId,
      reason: decision?.strategyReason,
      decisionReason: decision?.reason,
      complexity: decision?.taskComplexity,
      fallback: response?.fallback,
    },
    capabilities: {
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      requestedAgentId: ctx.requestedAgentId,
      activeSkillName: ctx.activeSkillInvocation?.skillName,
      toolsUsed,
    },
    score,
    agentScorecard: {
      agentId: ctx.agentId,
      agentName: ctx.agentName,
      model: `${provider}/${model}`,
      strategyProfile: decision?.strategyProfile,
      memoryUsed: memory.blocks.reduce((sum, block) => sum + (block.items?.length || block.count || 0), 0),
      toolsUsed: toolsUsed?.length || 0,
      warnings: warnings?.length || 0,
      score,
    },
    warnings,
  };
}

export function attachTurnQualityMetadata(
  ctx: RuntimeContext,
  metadata?: MessageMetadata,
  response?: ModelResponse,
): MessageMetadata {
  return {
    ...(metadata || {}),
    turnQuality: buildTurnQualitySummary(ctx, response),
  };
}
