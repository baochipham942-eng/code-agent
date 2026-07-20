import { buildCritiquePrompt } from './prompt';
import {
  CRITIQUE_DIMENSIONS,
  CRITIQUE_SCORE_MAX,
  CRITIQUE_SCORE_MIN,
  CritiqueParseError,
} from './types';
import type {
  CritiqueDimension,
  CritiqueInput,
  CritiqueOptions,
  CritiqueResult,
  DimensionScore,
} from './types';

function clampScore(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < CRITIQUE_SCORE_MIN) return CRITIQUE_SCORE_MIN;
  if (rounded > CRITIQUE_SCORE_MAX) return CRITIQUE_SCORE_MAX;
  return rounded;
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) return inner;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function parseScores(value: unknown): Map<CritiqueDimension, DimensionScore> {
  const out = new Map<CritiqueDimension, DimensionScore>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const dim = row.dimension;
    if (typeof dim !== 'string') continue;
    if (!CRITIQUE_DIMENSIONS.includes(dim as CritiqueDimension)) continue;
    const score = clampScore(row.score);
    if (score === undefined) continue;
    const reason = typeof row.reason === 'string' && row.reason.trim().length > 0 ? row.reason.trim() : 'N/A';
    out.set(dim as CritiqueDimension, { dimension: dim as CritiqueDimension, score, reason });
  }
  return out;
}

function fillMissingDimensions(parsed: Map<CritiqueDimension, DimensionScore>): DimensionScore[] {
  return CRITIQUE_DIMENSIONS.map((dim) => {
    const hit = parsed.get(dim);
    if (hit) return hit;
    return { dimension: dim, score: CRITIQUE_SCORE_MIN, reason: '判官未给出该维度评分，默认 1' };
  });
}

function averageScore(scores: DimensionScore[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, s) => acc + s.score, 0);
  return Math.round((sum / scores.length) * 100) / 100;
}

export function parseCritiqueResponse(raw: string): CritiqueResult {
  const block = extractJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (err) {
    throw new CritiqueParseError(
      `judge 输出无法解析为 JSON: ${(err as Error).message}`,
      raw,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CritiqueParseError('judge 输出不是 JSON 对象', raw);
  }
  const root = parsed as Record<string, unknown>;
  const scoresMap = parseScores(root.scores);
  if (scoresMap.size === 0) {
    throw new CritiqueParseError('judge 输出未包含任何合法 dimension score', raw);
  }
  const scores = fillMissingDimensions(scoresMap);
  const summary =
    typeof root.summary === 'string' && root.summary.trim().length > 0
      ? root.summary.trim()
      : '判官未给出 summary';
  return {
    scores,
    overall: averageScore(scores),
    summary,
    raw,
  };
}

export async function runCritique(
  input: CritiqueInput,
  options: CritiqueOptions,
): Promise<CritiqueResult> {
  const prompt = buildCritiquePrompt(input);
  const raw = await options.caller(prompt);
  return parseCritiqueResponse(raw);
}
