import { describe, expect, it } from 'vitest';
import {
  buildEvalCenterReadFacade,
  type EvalCenterSessionInfo,
  type StructuredReplay,
} from '../../../src/shared/contract/evaluation';
import type { ReviewQueueItem } from '../../../src/shared/contract/reviewQueue';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';

const toolDistribution = {
  Read: 0,
  Edit: 0,
  Write: 0,
  Bash: 0,
  Search: 0,
  Web: 0,
  Agent: 0,
  Skill: 0,
  Other: 0,
};

const sessionInfo: EvalCenterSessionInfo = {
  title: 'Facade Session',
  modelProvider: 'mock',
  modelName: 'gpt-test',
  startTime: 100,
  workingDirectory: '/tmp/project',
  status: 'completed',
  turnCount: 1,
  totalTokens: 12,
  estimatedCost: 0,
};

function buildReplay(sessionId: string): StructuredReplay {
  return {
    sessionId,
    traceIdentity: buildSessionTraceIdentity(sessionId),
    traceSource: 'session_replay',
    dataSource: 'telemetry',
    turns: [],
    summary: {
      totalTurns: 0,
      toolDistribution,
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 0,
      metricAvailability: {
        dataSource: 'telemetry',
        toolDistribution: 'telemetry',
        selfRepair: 'telemetry',
        actualArgs: 'unavailable',
      },
    },
  };
}

function buildReviewItem(sessionId: string): ReviewQueueItem {
  return {
    id: `review:session:${sessionId}`,
    trace: buildSessionTraceIdentity(sessionId),
    sessionId,
    sessionTitle: 'Queued Session',
    reason: 'manual_review',
    enqueueSource: 'session_list',
    source: 'session_list',
    createdAt: 100,
    updatedAt: 100,
  };
}

describe('buildEvalCenterReadFacade', () => {
  it('exposes stable trace, data, metric, session, queue, and replay fields', () => {
    const replay = buildReplay('session-42');
    const queuedItem = buildReviewItem('session-42');

    const facade = buildEvalCenterReadFacade({
      sessionId: 'session-42',
      sessionInfo,
      structuredReplay: replay,
      reviewQueueItems: [queuedItem],
    });

    expect(facade.traceIdentity.traceId).toBe('session:session-42');
    expect(facade.traceSource).toBe('session_replay');
    expect(facade.dataSource).toBe('telemetry');
    expect(facade.enqueueSource).toBe('session_list');
    expect(facade.metricAvailability?.dataSource).toBe('telemetry');
    expect(facade.sessionInfo).toBe(sessionInfo);
    expect(facade.structuredReplay).toBe(replay);
    expect(facade.reviewQueueState).toMatchObject({
      isQueued: true,
      enqueueSource: 'session_list',
      queuedItem,
    });
  });

  it('falls back to a session trace identity before replay data is available', () => {
    const facade = buildEvalCenterReadFacade({
      sessionId: 'session-without-replay',
      reviewQueueItems: [],
    });

    expect(facade.traceIdentity).toEqual(buildSessionTraceIdentity('session-without-replay'));
    expect(facade.traceSource).toBe('session_replay');
    expect(facade.dataSource).toBeNull();
    expect(facade.enqueueSource).toBeNull();
    expect(facade.reviewQueueState.isQueued).toBe(false);
    expect(facade.structuredReplay).toBeNull();
  });
});
