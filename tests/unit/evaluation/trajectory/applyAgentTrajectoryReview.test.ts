import { describe, expect, it } from 'vitest';

import {
  extractAgentTrajectoryReviewDecision,
  parseAgentTrajectoryReviewPacketMarkdown,
} from '../../../../scripts/apply-agent-trajectory-review';

describe('extractAgentTrajectoryReviewDecision', () => {
  it('requires an explicit reviewed dataset role and never applies suggestedAction alone', () => {
    expect(
      extractAgentTrajectoryReviewDecision({
        sessionId: 'session-1',
        currentDatasetRole: 'diagnostic',
        suggestedAction: 'verify_core_eval',
      }),
    ).toBeUndefined();

    expect(
      extractAgentTrajectoryReviewDecision({
        sessionId: 'session-1',
        currentDatasetRole: 'diagnostic',
        suggestedAction: 'verify_core_eval',
        reviewedDatasetRole: 'core_eval',
        reviewedBy: 'dad',
        reviewNotes: 'verified in replay dialog',
      }),
    ).toEqual({
      sessionId: 'session-1',
      datasetRole: 'core_eval',
      reviewedBy: 'dad',
      notes: 'verified in replay dialog',
    });
  });

  it('accepts nested review decisions with task kind overrides', () => {
    expect(
      extractAgentTrajectoryReviewDecision({
        sessionId: 'session-2',
        review: {
          datasetRole: 'excluded',
          taskKind: 'ordinary_chat',
          notes: 'not an agent task',
        },
      }),
    ).toEqual({
      sessionId: 'session-2',
      datasetRole: 'excluded',
      taskKind: 'ordinary_chat',
      notes: 'not an agent task',
    });
  });

  it('treats an empty review worksheet row as pending human review', () => {
    expect(
      extractAgentTrajectoryReviewDecision({
        sessionId: 'session-3',
        currentDatasetRole: 'core_eval',
        review: {
          datasetRole: null,
          taskKind: null,
          reviewedBy: null,
          notes: null,
        },
      }),
    ).toBeUndefined();

    expect(
      extractAgentTrajectoryReviewDecision({
        sessionId: 'session-3',
        currentDatasetRole: 'core_eval',
        review: {
          datasetRole: 'core_eval',
          reviewedBy: 'dad',
        },
      }),
    ).toEqual({
      sessionId: 'session-3',
      datasetRole: 'core_eval',
      reviewedBy: 'dad',
    });
  });

  it('parses explicit decisions from the human review packet markdown only when final role is filled', () => {
    const items = parseAgentTrajectoryReviewPacketMarkdown(`
# Agent Trajectory Review Packet

| # | Priority | P3 scope | Session | Suggested action | Current role | Tier | Task | Source | Failures | Final review.datasetRole | Notes |
| -: | -------- | -------- | ------- | ---------------- | ------------ | ---- | ---- | ------ | -------- | ------------------------ | ----- |
| 1 | high | agent_candidate | session-empty | review_diagnostic | diagnostic | G1 | search | audit_backfill | missing_tool_definition |  | keep pending |
| 2 | medium | agent_candidate | session-core | verify_core_eval | core_eval | G2 | coding | audit_backfill | none | Core eval | verified in Replay |
`);

    expect(items).toHaveLength(2);
    expect(extractAgentTrajectoryReviewDecision(items[0]!)).toBeUndefined();
    expect(extractAgentTrajectoryReviewDecision(items[1]!)).toEqual({
      sessionId: 'session-core',
      datasetRole: 'core_eval',
      notes: 'verified in Replay',
    });
  });
});
