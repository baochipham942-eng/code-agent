import type { AiReviewDimension } from '@shared/contract/evaluation';
import { isAiReviewDimension } from '@host/testing/judge/dimensions';

export function parseAiReviewList(raw: string): AiReviewDimension[] {
  const values = raw.split(',').map((item) => item.trim()).filter(Boolean);
  const unknown = values.filter((item) => !isAiReviewDimension(item));
  if (unknown.length > 0) throw new Error(`Invalid --ai-review dimension: ${unknown.join(', ')}`);
  return Array.from(new Set(values)) as AiReviewDimension[];
}
