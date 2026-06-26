import type {
  AgentQualityScorecard,
  TurnQualityScoreBreakdown,
  TurnQualityScoreDimension,
  TurnQualityScoreSummary,
} from '../../shared/contract/turnQuality';
import type { ReplayBlock, ReplayTurn, StructuredReplay } from '../../shared/contract/evaluation';

function grade(score: number, max: number): TurnQualityScoreSummary['grade'] {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 0.9) return 'excellent';
  if (ratio >= 0.75) return 'good';
  if (ratio >= 0.55) return 'watch';
  return 'risk';
}

function status(score: number, max: number): TurnQualityScoreBreakdown['status'] {
  const ratio = max > 0 ? score / max : 0;
  if (ratio >= 0.8) return 'good';
  if (ratio >= 0.55) return 'watch';
  return 'risk';
}

function memoryAuditBlocks(turns: ReplayTurn[]): ReplayBlock[] {
  return turns.flatMap((turn) => turn.blocks.filter((block) => block.type === 'memory_audit' && block.memoryAudit));
}

function aggregateBreakdowns(scores: TurnQualityScoreSummary[]): TurnQualityScoreSummary {
  const byDimension = new Map<TurnQualityScoreDimension, TurnQualityScoreBreakdown[]>();
  for (const score of scores) {
    for (const item of score.breakdown) {
      const list = byDimension.get(item.dimension) || [];
      list.push(item);
      byDimension.set(item.dimension, list);
    }
  }

  const breakdown: TurnQualityScoreBreakdown[] = Array.from(byDimension.entries()).map(([dimension, items]) => {
    const max = Math.round(items.reduce((sum, item) => sum + item.max, 0) / items.length);
    const score = Math.round(items.reduce((sum, item) => sum + item.score, 0) / items.length);
    const reasons = Array.from(new Set(items.flatMap((item) => item.reasons))).slice(0, 4);
    return {
      dimension,
      score,
      max,
      status: status(score, max),
      reasons,
    };
  });

  const total = breakdown.reduce((sum, item) => sum + item.score, 0);
  const max = breakdown.reduce((sum, item) => sum + item.max, 0);
  return {
    score: total,
    max,
    grade: grade(total, max),
    breakdown,
  };
}

function buildFallbackScore(replay: StructuredReplay): TurnQualityScoreSummary {
  const toolCount = Object.values(replay.summary.toolDistribution).reduce((sum, count) => sum + count, 0);
  const hasModelDecision = replay.turns.some((turn) => turn.blocks.some((block) => Boolean(block.modelDecision)));
  const hasMemoryAudit = replay.turns.some((turn) => turn.blocks.some((block) => Boolean(block.memoryAudit)));
  const hasFailures = replay.turns.some((turn) => turn.blocks.some((block) => block.type === 'error' || block.toolCall?.success === false));
  const completeness = replay.summary.telemetryCompleteness;

  const breakdown: TurnQualityScoreBreakdown[] = [
    {
      dimension: 'strategy',
      score: hasModelDecision ? 16 : 8,
      max: 20,
      status: hasModelDecision ? 'good' : 'watch',
      reasons: [hasModelDecision ? 'Replay 包含模型决策' : '缺少模型决策证据'],
    },
    {
      dimension: 'memory',
      score: hasMemoryAudit ? 18 : 10,
      max: 20,
      status: hasMemoryAudit ? 'good' : 'watch',
      reasons: [hasMemoryAudit ? 'Replay 包含 Memory Audit' : '缺少 Memory Audit 证据'],
    },
    {
      dimension: 'tooling',
      score: toolCount > 0 ? 16 : 12,
      max: 20,
      status: 'good',
      reasons: [toolCount > 0 ? `Replay 包含 ${toolCount} 次工具调用` : '无工具调用'],
    },
    {
      dimension: 'capability',
      score: completeness?.hasToolSchemas ? 16 : 11,
      max: 20,
      status: completeness?.hasToolSchemas ? 'good' : 'watch',
      reasons: [completeness?.hasToolSchemas ? '工具 schema 完整' : '工具 schema 不完整'],
    },
    {
      dimension: 'delivery',
      score: hasFailures ? 10 : 18,
      max: 20,
      status: hasFailures ? 'watch' : 'good',
      reasons: [hasFailures ? 'Replay 中存在失败步骤' : 'Replay 未发现失败步骤'],
    },
  ];
  const total = breakdown.reduce((sum, item) => sum + item.score, 0);
  const max = breakdown.reduce((sum, item) => sum + item.max, 0);
  return { score: total, max, grade: grade(total, max), breakdown };
}

function aggregateAgentScorecards(blocks: ReplayBlock[]): AgentQualityScorecard[] {
  const cards = blocks
    .map((block) => block.memoryAudit?.agentScorecard)
    .filter((card): card is AgentQualityScorecard => Boolean(card));
  if (cards.length === 0) return [];

  const groups = new Map<string, AgentQualityScorecard[]>();
  for (const card of cards) {
    const key = card.agentId || card.agentName || 'main';
    const list = groups.get(key) || [];
    list.push(card);
    groups.set(key, list);
  }

  return Array.from(groups.entries()).map(([key, items]) => {
    const representative = items[items.length - 1];
    const score = aggregateBreakdowns(items.map((item) => item.score));
    return {
      ...representative,
      agentId: representative.agentId || key,
      memoryUsed: items.reduce((sum, item) => sum + item.memoryUsed, 0),
      toolsUsed: items.reduce((sum, item) => sum + item.toolsUsed, 0),
      warnings: items.reduce((sum, item) => sum + item.warnings, 0),
      score,
    };
  });
}

export function attachSessionQualityScoring(replay: StructuredReplay): StructuredReplay {
  const auditBlocks = memoryAuditBlocks(replay.turns);
  const turnScores = auditBlocks
    .map((block) => block.memoryAudit?.score)
    .filter((score): score is TurnQualityScoreSummary => Boolean(score));
  const qualityScore = turnScores.length > 0
    ? aggregateBreakdowns(turnScores)
    : buildFallbackScore(replay);
  const agentScorecards = aggregateAgentScorecards(auditBlocks);

  return {
    ...replay,
    summary: {
      ...replay.summary,
      qualityScore,
      agentScorecards,
    },
  };
}
