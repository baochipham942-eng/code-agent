// ============================================================================
// Evaluation IPC Schemas
// ============================================================================
//
// PR-1 sample：只填 `SAVE_ANNOTATIONS` 一个 channel，证明 typed pipeline 可跑。
// 其余 evaluation channels 在 PR-5 (IPC 全量迁移) 阶段补齐。
// ============================================================================

import { z } from 'zod';
import { EVALUATION_CHANNELS } from '../channels';
import { channelSchema } from './index';

// ----------------------------------------------------------------------------
// 与 packages/eval-harness/src/runner/AnnotationStore.ts 的 Annotation 接口对齐
// ----------------------------------------------------------------------------

const ErrorTypeSchema = z.enum([
  'tool_misuse',
  'reasoning_error',
  'incomplete_output',
  'hallucination',
  'security_violation',
]);

const AnnotationSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  round: z.number().int().nonnegative(),
  timestamp: z.string(),
  errorTypes: z.array(ErrorTypeSchema),
  rootCause: z.string(),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  annotator: z.string(),
});

// ----------------------------------------------------------------------------
// SAVE_ANNOTATIONS
// ----------------------------------------------------------------------------

export const SAVE_ANNOTATIONS = channelSchema({
  channel: EVALUATION_CHANNELS.SAVE_ANNOTATIONS,
  payload: AnnotationSchema,
  response: z.object({
    success: z.boolean(),
    error: z.string().optional(),
  }),
});
