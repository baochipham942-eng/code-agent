// ============================================================================
// CompressionPipeline — Coordinates compression layers based on token usage
// ============================================================================
// Pipeline flow:
//   L1 (toolResultBudget) — always runs, per-result budget
//   L2 (snip)             — if usage ≥ 50% and enabled
//   L3 (microcompact)     — if usage ≥ 60% and enabled
//   L4 (contextCollapse)  — if usage ≥ 75% and enabled + summarize provided
//   L5 (autocompact)      — NOT called here; reported to loop for decision
//   L6 (overflowRecovery) — called from handleOverflow()
// ============================================================================

import { CompressionState } from './compressionState';
import { ProjectionEngine, type ProjectableMessage } from './projectionEngine';
import { estimateTokens } from './tokenEstimator';
import { applyToolResultBudget } from './layers/toolResultBudget';
import { applySnip } from './layers/snip';
import { applyMicrocompact } from './layers/microcompact';
import { applyContextCollapse } from './layers/contextCollapse';
import { applyOverflowRecovery } from './layers/overflowRecovery';
import type { ContextInterventionSnapshot } from '../../shared/contract/contextView';
import { getProtectedMessageIds } from './contextInterventionHelpers';

export interface PipelineConfig {
  maxTokens: number;
  currentTurnIndex: number;
  isMainThread: boolean;
  cacheHot: boolean;
  idleMinutes: number;
  summarize?: (msgs: Array<{ role: string; content: string }>) => Promise<string>;
  enableSnip: boolean;
  enableMicrocompact: boolean;
  enableContextCollapse: boolean;
  toolResultBudget: number; // default: 2000
  interventions?: ContextInterventionSnapshot;
}

export interface PipelineResult {
  apiView: ProjectableMessage[];
  totalTokens: number;
  layersTriggered: string[];
  compressionState: CompressionState;
}

// Token usage thresholds (as fraction of maxTokens)
const THRESHOLDS = {
  snip: 0.50,
  microcompact: 0.60,
  contextCollapse: 0.75,
  autocompact: 0.85,
} as const;

/**
 * Count total tokens across an array of ProjectableMessages.
 */
function countProjectedTokens(messages: ProjectableMessage[]): number {
  let total = 3; // base envelope overhead
  for (const msg of messages) {
    total += 4; // per-message role overhead
    total += estimateTokens(msg.content);
  }
  return total;
}

/**
 * Extend messages with turnIndex for snip layer.
 * Falls back to array-position-based turn index if not present.
 */
function withTurnIndex(
  messages: ProjectableMessage[],
): Array<ProjectableMessage & { turnIndex: number }> {
  return messages.map((m, i) => ({
    ...m,
    turnIndex: typeof (m as Record<string, unknown>).turnIndex === 'number'
      ? (m as unknown as { turnIndex: number }).turnIndex
      : i,
  }));
}

export class CompressionPipeline {
  private projectionEngine = new ProjectionEngine();

  /**
   * Evaluate the transcript, run compression layers as needed, return API view.
   */
  async evaluate(
    transcript: ProjectableMessage[],
    state: CompressionState,
    config: PipelineConfig,
  ): Promise<PipelineResult> {
    const layersTriggered: string[] = [];
    const protectedMessageIds = config.interventions
      ? getProtectedMessageIds(config.interventions)
      : new Set<string>();

    // -------------------------------------------------------------------------
    // L1: Tool result budget — always runs (mutates transcript messages)
    // -------------------------------------------------------------------------
    applyToolResultBudget(transcript, state, {
      maxTokensPerResult: config.toolResultBudget ?? 2000,
      protectedMessageIds,
    });
    layersTriggered.push('tool-result-budget');

    // -------------------------------------------------------------------------
    // Project and count tokens
    // -------------------------------------------------------------------------
    let apiView = this.projectionEngine.projectMessages(transcript, state);
    let totalTokens = countProjectedTokens(apiView);
    const usageFraction = totalTokens / config.maxTokens;

    // -------------------------------------------------------------------------
    // L2: Snip — if ≥ 50%
    // -------------------------------------------------------------------------
    if (usageFraction >= THRESHOLDS.snip && config.enableSnip) {
      const messagesWithTurnIndex = withTurnIndex(transcript);
      applySnip(messagesWithTurnIndex, state, {
        currentTurnIndex: config.currentTurnIndex,
        preserveRecentTurns: 5,
        protectedMessageIds,
      });
      layersTriggered.push('snip');

      // Re-project after snip
      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countProjectedTokens(apiView);
    }

    // -------------------------------------------------------------------------
    // L3: Microcompact — if ≥ 60%
    // -------------------------------------------------------------------------
    const postSnipUsage = totalTokens / config.maxTokens;
    if (postSnipUsage >= THRESHOLDS.microcompact && config.enableMicrocompact) {
      applyMicrocompact(transcript, state, {
        isMainThread: config.isMainThread,
        cacheHot: config.cacheHot,
        idleMinutes: config.idleMinutes,
        protectedMessageIds,
      });
      layersTriggered.push('microcompact');

      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countProjectedTokens(apiView);
    }

    // -------------------------------------------------------------------------
    // L4: Context Collapse — if ≥ 75%
    // -------------------------------------------------------------------------
    const postMicroUsage = totalTokens / config.maxTokens;
    if (
      postMicroUsage >= THRESHOLDS.contextCollapse &&
      config.enableContextCollapse &&
      config.summarize !== undefined
    ) {
      const messagesWithTurnIndex = withTurnIndex(transcript);
      await applyContextCollapse(messagesWithTurnIndex, state, {
        minSpanSize: 3,
        summarize: config.summarize,
        maxSummaryTokens: 200,
        protectedMessageIds,
      });
      layersTriggered.push('contextCollapse');

      apiView = this.projectionEngine.projectMessages(transcript, state);
      totalTokens = countProjectedTokens(apiView);
    }

    // -------------------------------------------------------------------------
    // L5: Autocompact — NOT triggered here, reported to loop
    // -------------------------------------------------------------------------
    const finalUsage = totalTokens / config.maxTokens;
    if (finalUsage >= THRESHOLDS.autocompact) {
      layersTriggered.push('autocompact-needed');
    }

    return {
      apiView,
      totalTokens,
      layersTriggered,
      compressionState: state,
    };
  }

  /**
   * Handle API overflow: apply L6 overflow recovery.
   */
  handleOverflow(state: CompressionState): void {
    applyOverflowRecovery(state);
  }
}
