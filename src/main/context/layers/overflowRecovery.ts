// ============================================================================
// L6: Overflow Recovery — drain commit when API returns overflow error
// ============================================================================
// Simple layer: writes a drain commit to signal that recovery happened.
// Called by the loop when the API returns a context overflow error.
// ============================================================================

import { CompressionState } from '../compressionState';

/**
 * Apply overflow recovery: write a drain commit to the state.
 * This signals to the pipeline/loop that an overflow was detected and recovery
 * was initiated. The loop can use this to trigger autocompact or reset.
 */
export function applyOverflowRecovery(state: CompressionState): void {
  state.applyCommit({
    layer: 'overflow-recovery',
    operation: 'drain',
    targetMessageIds: [],
    timestamp: Date.now(),
  });
}
