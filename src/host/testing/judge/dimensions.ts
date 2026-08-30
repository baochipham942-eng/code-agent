import type { AiReviewDimension } from '../../../shared/contract/evaluation';

export const AI_REVIEW_DIMENSIONS = [
  'task_completed',
  'tool_choice',
  'confirmed_before_acting',
  'no_extra_changes',
  'self_tested',
] as const;

type MissingAiReviewDimension = Exclude<AiReviewDimension, (typeof AI_REVIEW_DIMENSIONS)[number]>;
type UnknownAiReviewDimension = Exclude<(typeof AI_REVIEW_DIMENSIONS)[number], AiReviewDimension>;
const _allDimensionsDeclared: MissingAiReviewDimension extends never ? true : never = true;
const _allDeclaredDimensionsKnown: UnknownAiReviewDimension extends never ? true : never = true;
void _allDimensionsDeclared;
void _allDeclaredDimensionsKnown;

interface AiReviewDimensionDefinition {
  id: AiReviewDimension;
  shadow?: 'deterministic_pass' | 'sim_no_write_before_rule';
  requiresExpectation: boolean;
}

const AI_REVIEW_DIMENSION_CONFIG = {
  task_completed: { shadow: 'deterministic_pass', requiresExpectation: false },
  tool_choice: { requiresExpectation: true },
  confirmed_before_acting: { shadow: 'sim_no_write_before_rule', requiresExpectation: false },
  no_extra_changes: { requiresExpectation: true },
  self_tested: { requiresExpectation: true },
} as const satisfies Record<AiReviewDimension, Omit<AiReviewDimensionDefinition, 'id'>>;

export const AI_REVIEW_DIMENSION_DEFINITIONS: readonly AiReviewDimensionDefinition[] =
  AI_REVIEW_DIMENSIONS.map((id) => ({ id, ...AI_REVIEW_DIMENSION_CONFIG[id] }));

export function isAiReviewDimension(value: string): value is AiReviewDimension {
  return (AI_REVIEW_DIMENSIONS as readonly string[]).includes(value);
}

export function getAiReviewDimensionDefinition(
  dimension: AiReviewDimension,
): AiReviewDimensionDefinition {
  const definition = AI_REVIEW_DIMENSION_DEFINITIONS.find((item) => item.id === dimension);
  if (!definition) throw new Error(`Unknown AI review dimension: ${dimension}`);
  return definition;
}
