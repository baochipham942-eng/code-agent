import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { storeState } = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
}));

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: () => storeState,
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    isAvailable: () => false,
    invoke: vi.fn(),
  },
}));

import { EvalDashboard } from '../../../src/renderer/components/features/evalCenter/EvalDashboard';
import { TraceView } from '../../../src/renderer/components/features/evalCenter/TraceView';
import { SessionEvalView } from '../../../src/renderer/components/features/evalCenter/pages/SessionEvalView';

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

const traceIdentity = {
  traceId: 'session:session-1',
  traceSource: 'session_replay' as const,
  source: 'session_replay' as const,
  sessionId: 'session-1',
  replayKey: 'session-1',
};

const facadeSessionInfo = {
  title: 'Facade Session',
  modelProvider: 'facade-provider',
  modelName: 'facade-model',
  startTime: 1000,
  endTime: 2000,
  generationId: 'generation-facade',
  workingDirectory: '/tmp/facade',
  status: 'completed',
  turnCount: 1,
  totalTokens: 2400,
  estimatedCost: 0.01,
};

const staleSessionInfo = {
  ...facadeSessionInfo,
  title: 'Stale Session',
  modelProvider: 'stale-provider',
  modelName: 'stale-model',
};

function buildReplay(sessionId: string, content: string, dataSource: 'telemetry' | 'transcript_fallback') {
  return {
    sessionId,
    traceIdentity: {
      ...traceIdentity,
      traceId: `session:${sessionId}`,
      sessionId,
      replayKey: sessionId,
    },
    traceSource: 'session_replay' as const,
    dataSource,
    turns: [
      {
        turnNumber: 1,
        blocks: [
          {
            type: 'text' as const,
            content,
            timestamp: 100,
          },
        ],
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 30,
        startTime: 100,
      },
    ],
    summary: {
      totalTurns: 1,
      toolDistribution,
      thinkingRatio: 0,
      selfRepairChains: 0,
      totalDurationMs: 30,
      metricAvailability: {
        dataSource,
        toolDistribution: dataSource === 'telemetry' ? 'telemetry' as const : 'transcript' as const,
        selfRepair: dataSource === 'telemetry' ? 'telemetry' as const : 'transcript' as const,
        actualArgs: 'unavailable' as const,
      },
    },
  };
}

function resetStoreState() {
  for (const key of Object.keys(storeState)) {
    delete storeState[key];
  }

  const structuredReplay = buildReplay('session-1', 'facade replay', 'transcript_fallback');

  Object.assign(storeState, {
    sessionInfo: staleSessionInfo,
    objective: null,
    latestEvaluation: null,
    readFacade: {
      traceIdentity,
      traceSource: 'session_replay',
      dataSource: 'transcript_fallback',
      enqueueSource: null,
      metricAvailability: structuredReplay.summary.metricAvailability,
      sessionInfo: facadeSessionInfo,
      reviewQueueState: {
        items: [],
        queuedItem: null,
        isQueued: false,
        enqueueSource: null,
      },
      structuredReplay,
    },
    replayData: buildReplay('session-2', 'stale replay', 'telemetry'),
    replayLoading: false,
    loadReplay: vi.fn(),
    loadReviewQueue: vi.fn(),
    enqueueFailureFollowup: vi.fn(),
    loadSession: vi.fn(),
  });
}

describe('Eval Center read facade consumption', () => {
  beforeEach(() => {
    resetStoreState();
  });

  it('renders TraceView from the current readFacade replay and data source', () => {
    const html = renderToStaticMarkup(React.createElement(TraceView, {
      sessionId: 'session-1',
    }));

    expect(html).toContain('Transcript fallback');
    expect(html).toContain('facade replay');
    expect(html).not.toContain('stale replay');
  });

  it('renders the session eval header from readFacade session info first', () => {
    const html = renderToStaticMarkup(React.createElement(SessionEvalView, {
      sessionId: 'session-1',
      onBack: vi.fn(),
    }));

    expect(html).toContain('Facade Session');
    expect(html).toContain('facade-provider/facade-model');
    expect(html).not.toContain('Stale Session');
    expect(html).not.toContain('stale-provider/stale-model');
  });

  it('passes readFacade session info into the dashboard score summary', () => {
    const html = renderToStaticMarkup(React.createElement(EvalDashboard, {
      sessionId: 'session-1',
    }));

    expect(html).toContain('facade-provider/facade-model');
    expect(html).not.toContain('stale-provider/stale-model');
  });
});
