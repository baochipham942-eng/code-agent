export const EVALUATION_CHANNELS = {
  RUN_SUITE: 'evaluation:run-suite',
  RUN_EVENTS: 'evaluation:run-events',
  ABORT_RUN: 'evaluation:abort-run',
  SCORERS_OVERVIEW: 'evaluation:scorers-overview',
  LIST_EXPERIMENTS: 'evaluation:list-experiments',
  LOAD_EXPERIMENT: 'evaluation:load-experiment',
  LOAD_CASE: 'evaluation:load-case',
  LIST_CASES: 'evaluation:list-cases',
  SAVE_CASE: 'evaluation:save-case',
  SAVE_ANNOTATION: 'evaluation:save-annotation',
  LIST_ANNOTATIONS: 'evaluation:list-annotations',
} as const;
