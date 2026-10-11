/** Thresholds used by the background dynamic-workflow stall detector. */
export const WORKFLOW_STALL_THRESHOLDS = {
  /** No activity while no agent call is in flight. */
  N_HARD_MS: 600_000,
  /** UI-only soft threshold; the detector does not announce at this threshold. */
  N_SOFT_MS: 120_000,
  /** No activity allowed while at least one agent call is in flight. */
  SINGLE_CALL_MS: 1_800_000,
  /** Maximum durable stall epochs announced for one run. */
  MAX_EPOCHS: 3,
} as const;
