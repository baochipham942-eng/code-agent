import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const storeState = {
  sessionList: [
    {
      id: 'session-1',
      title: 'Queued Session',
      modelProvider: 'openai',
      modelName: 'gpt-5.4',
      startTime: 1000,
      turnCount: 3,
      totalTokens: 3200,
      estimatedCost: 0.12,
      status: 'completed',
    },
    {
      id: 'session-2',
      title: 'Fresh Session',
      modelProvider: 'openai',
      modelName: 'gpt-4.1-mini',
      startTime: 2000,
      turnCount: 2,
      totalTokens: 1200,
      estimatedCost: 0,
      status: 'completed',
    },
  ],
  sessionListLoading: false,
  filterStatus: 'all' as const,
  sortBy: 'time' as const,
  reviewQueue: [
    {
      id: 'review:session:session-1',
      trace: {
        traceId: 'session:session-1',
        source: 'session_replay' as const,
        sessionId: 'session-1',
        replayKey: 'session-1',
      },
      sessionId: 'session-1',
      sessionTitle: 'Queued Session',
      reason: 'failure_followup' as const,
      source: 'replay_failure' as const,
      createdAt: 100,
      updatedAt: 100,
    },
  ],
  reviewQueueLoading: false,
  loadSessionList: vi.fn(),
  loadReviewQueue: vi.fn(),
  enqueueReviewItem: vi.fn(),
  setFilterStatus: vi.fn(),
  setSortBy: vi.fn(),
};

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: () => storeState,
}));

import { SessionListView } from '../../../src/renderer/components/features/evalCenter/SessionListView';

describe('SessionListView review queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the review queue and marks queued sessions', () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionListView, {
        onSelectSession: vi.fn(),
      }),
    );

    expect(html).toContain('Review Queue');
    expect(html).toContain('当前支持手动加入，也支持从 Replay 的 Failure Follow-up 入口回流。');
    expect(html).toContain('Queued Session');
    expect(html).toContain('Replay');
    expect(html).toContain('失败回看');
    expect(html).toContain('已在 Review');
    expect(html).toContain('加入 Review');
  });
});
