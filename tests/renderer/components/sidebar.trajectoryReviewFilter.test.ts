import { describe, expect, it } from 'vitest';

import { matchesTrajectoryReviewFilter } from '../../../src/renderer/components/features/sidebar/useSidebarDerivedSessions';
import type { AgentTrajectorySessionQualitySummary } from '../../../src/shared/contract/agentTrajectory';

function summary(source: AgentTrajectorySessionQualitySummary['collection']['source']): AgentTrajectorySessionQualitySummary {
  return {
    sessionId: 'session-trajectory-review',
    quality: {
      tier: 'G2',
      passed: true,
      exportReady: true,
      failures: [],
      warnings: [],
      classification: {
        taskKind: 'coding',
        datasetRole: 'core_eval',
        reason: 'g2_agent_task',
        labels: [],
      },
      metrics: {
        turnCount: 1,
        modelCallCount: 1,
        toolCallCount: 1,
        toolResultCount: 1,
        eventCount: 1,
        toolDefinitionCount: 1,
        finalAnswerPresent: true,
        pendingToolResultCount: 0,
      },
    },
    collection: {
      schemaVersion: 1,
      intent: 'new_core_eval_candidate',
      taskKind: 'coding',
      datasetRole: 'core_eval',
      datasetVersion: 'agent-trajectory-v1',
      source,
      reason: source === 'manual_review' ? 'manual_review_override' : 'g2_agent_task',
      failureTags: [],
      labels: [],
      createdAt: 1,
      updatedAt: 2,
      reviewedAt: source === 'manual_review' ? 2 : undefined,
    },
  };
}

describe('matchesTrajectoryReviewFilter', () => {
  it('treats non-manual sources as pending review and manual_review as reviewed', () => {
    expect(matchesTrajectoryReviewFilter(summary('quality_gate'), 'pending')).toBe(true);
    expect(matchesTrajectoryReviewFilter(summary('audit_backfill'), 'pending')).toBe(true);
    expect(matchesTrajectoryReviewFilter(summary('manual_review'), 'pending')).toBe(false);

    expect(matchesTrajectoryReviewFilter(summary('manual_review'), 'reviewed')).toBe(true);
    expect(matchesTrajectoryReviewFilter(summary('quality_gate'), 'reviewed')).toBe(false);
    expect(matchesTrajectoryReviewFilter(undefined, 'pending')).toBe(false);
    expect(matchesTrajectoryReviewFilter(undefined, 'all')).toBe(true);
  });
});
