import type { DesignBrief } from '../../shared/contract/designBrief';

export type CritiqueDimension =
  | 'palette'
  | 'typography'
  | 'posture'
  | 'surface'
  | 'constraint';

export const CRITIQUE_DIMENSIONS: readonly CritiqueDimension[] = [
  'palette',
  'typography',
  'posture',
  'surface',
  'constraint',
] as const;

export const CRITIQUE_DIMENSION_LABELS: Record<CritiqueDimension, string> = {
  palette: 'Palette fidelity',
  typography: 'Typography match',
  posture: 'Posture coherence',
  surface: 'Surface fit',
  constraint: 'Constraint compliance',
};

export const CRITIQUE_DIMENSION_BRIEFS: Record<CritiqueDimension, string> = {
  palette: '产物用色是否落在 directionTokens.palette 给定的 5 色 OKLch 容差内（容差 ≈ ±5% L、±0.03 C、±15° h）',
  typography: '产物字体是否与 directionTokens.fonts 的 serif/sans stack 气质一致（不一定字面命中，但层级和气质要对）',
  posture: '整体气质是否兑现 directionTokens.posture 的中文一句（最主观、最依赖判断的一维）',
  surface: '产物结构与节奏是否符合 brief.surface（landing page 与 dashboard 不同，不要错位）',
  constraint: '是否遵守 brief.constraints 列出的硬约束（如有）',
};

export const CRITIQUE_SCORE_MIN = 1;
export const CRITIQUE_SCORE_MAX = 5;

export interface DimensionScore {
  dimension: CritiqueDimension;
  score: number;
  reason: string;
}

export type CritiqueArtifactKind = 'html' | 'markdown' | 'code' | 'text';

export interface CritiqueArtifact {
  kind: CritiqueArtifactKind;
  content: string;
  note?: string;
}

export interface CritiqueResult {
  scores: DimensionScore[];
  overall: number;
  summary: string;
  raw?: string;
}

export interface CritiqueInput {
  brief: DesignBrief;
  artifact: CritiqueArtifact;
}

export type CritiqueCaller = (prompt: string) => Promise<string>;

export interface CritiqueOptions {
  caller: CritiqueCaller;
}

export class CritiqueParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'CritiqueParseError';
  }
}
