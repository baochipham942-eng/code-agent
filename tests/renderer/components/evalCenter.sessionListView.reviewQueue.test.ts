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
        traceSource: 'session_replay' as const,
        source: 'session_replay' as const,
        sessionId: 'session-1',
        replayKey: 'session-1',
      },
      sessionId: 'session-1',
      sessionTitle: 'Queued Session',
      reason: 'failure_followup' as const,
      enqueueSource: 'session_list' as const,
      source: 'replay_failure' as const,
      failureCapability: {
        sink: 'prompt_policy' as const,
        category: 'loop' as const,
        summary: 'Looped through the same action.',
        stepIndex: 4,
        confidence: 0.72,
        evidence: [4],
      },
      failureAsset: {
        id: 'failure-asset:review:session:session-1',
        reviewItemId: 'review:session:session-1',
        sessionId: 'session-1',
        traceId: 'session:session-1',
        status: 'draft' as const,
        sink: 'prompt_policy' as const,
        category: 'loop' as const,
        title: 'Prompt Policy · 循环卡住 draft',
        body: 'Looped through the same action.',
        stepIndex: 4,
        confidence: 0.72,
        evidence: [4],
        createdAt: 100,
        updatedAt: 100,
      },
      createdAt: 100,
      updatedAt: 100,
    },
  ],
  reviewQueueLoading: false,
  loadSessionList: vi.fn(),
  loadReviewQueue: vi.fn(),
  enqueueReviewItem: vi.fn(),
  updateFailureAssetStatus: vi.fn(),
  setFilterStatus: vi.fn(),
  setSortBy: vi.fn(),
};

vi.mock('../../../src/renderer/stores/evalCenterStore', () => ({
  useEvalCenterStore: () => storeState,
}));

import {
  buildReviewQueueFollowupPrompt,
  matchesReviewQueueAssetQuery,
  matchesSessionAssetQuery,
  SessionListView,
} from '../../../src/renderer/components/features/evalCenter/SessionListView';

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
    expect(html).toContain('搜索会话 / Review / Replay');
    expect(html).toContain('当前支持手动加入、Replay Failure Follow-up 和 Delivery Review。');
    expect(html).toContain('Queued Session');
    expect(html).toContain('Replay');
    expect(html).toContain('带评论继续');
    expect(html).toContain('失败回看');
    expect(html).toContain('会话列表');
    expect(html).toContain('Prompt Policy · 循环卡住');
    expect(html).toContain('Asset');
    expect(html).toContain('草稿');
    expect(html).toContain('标记待应用');
    expect(html).toContain('忽略');
    expect(html).toContain('已在 Review');
    expect(html).toContain('加入 Review');
  });

  it('builds a follow-up prompt with review comments and trace identity', () => {
    const prompt = buildReviewQueueFollowupPrompt(storeState.reviewQueue[0]);

    expect(prompt).toContain('继续处理 Review Queue 里的这一条');
    expect(prompt).toContain('会话：Queued Session');
    expect(prompt).toContain('Replay sessionId：session-1');
    expect(prompt).toContain('归因：Prompt Policy · 循环卡住');
    expect(prompt).toContain('评论：Looped through the same action.');
  });

  it('matches session and review queue assets by reusable search text', () => {
    expect(matchesSessionAssetQuery(storeState.sessionList[0], 'gpt-5.4')).toBe(true);
    expect(matchesSessionAssetQuery(storeState.sessionList[0], 'fresh')).toBe(false);

    expect(matchesReviewQueueAssetQuery(storeState.reviewQueue[0], 'prompt policy')).toBe(true);
    expect(matchesReviewQueueAssetQuery(storeState.reviewQueue[0], 'Looped through')).toBe(true);
    expect(matchesReviewQueueAssetQuery(storeState.reviewQueue[0], 'session-2')).toBe(false);
  });
});
