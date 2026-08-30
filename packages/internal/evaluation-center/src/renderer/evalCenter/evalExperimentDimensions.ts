export const EVAL_HARNESS_DIMENSIONS = [
  'contextCompression',
  'compressionPipeline',
  'scaffoldProfile',
  'thinkingInjection',
  'hooksEnabled',
  'toolMode',
] as const;

export type EvalHarnessDimension = (typeof EVAL_HARNESS_DIMENSIONS)[number];
