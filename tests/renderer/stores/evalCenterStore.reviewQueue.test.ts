import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: invokeMock,
  },
}));

import { useEvalCenterStore } from '../../../src/renderer/stores/evalCenterStore';
import { EVALUATION_CHANNELS } from '../../../src/shared/ipc/channels';

const reviewItem = {
  id: 'review:session:session-1',
  trace: {
    traceId: 'session:session-1',
    source: 'session_replay',
    sessionId: 'session-1',
    replayKey: 'session-1',
  },
  sessionId: 'session-1',
  sessionTitle: 'Review Session',
  reason: 'manual_review' as const,
  source: 'session_list' as const,
  createdAt: 100,
  updatedAt: 100,
};

describe('evalCenterStore review queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEvalCenterStore.getState().reset();
  });

  it('loads the persisted review queue', async () => {
    invokeMock.mockResolvedValueOnce([reviewItem]);

    await useEvalCenterStore.getState().loadReviewQueue();

    expect(invokeMock).toHaveBeenCalledWith(EVALUATION_CHANNELS.REVIEW_QUEUE_LIST);
    expect(useEvalCenterStore.getState().reviewQueue).toEqual([reviewItem]);
    expect(useEvalCenterStore.getState().reviewQueueLoading).toBe(false);
  });

  it('upserts an enqueued review item into the queue state', async () => {
    useEvalCenterStore.setState({
      reviewQueue: [{
        ...reviewItem,
        sessionTitle: 'Older Title',
        updatedAt: 50,
      }],
    });
    invokeMock.mockResolvedValueOnce({
      ...reviewItem,
      sessionTitle: 'Fresh Title',
      updatedAt: 200,
    });

    const result = await useEvalCenterStore.getState().enqueueReviewItem({
      sessionId: 'session-1',
      sessionTitle: 'Fresh Title',
      reason: 'manual_review',
      source: 'current_session_bar',
    });

    expect(invokeMock).toHaveBeenCalledWith(EVALUATION_CHANNELS.REVIEW_QUEUE_ENQUEUE, {
      sessionId: 'session-1',
      sessionTitle: 'Fresh Title',
      reason: 'manual_review',
      source: 'current_session_bar',
    });
    expect(result?.sessionTitle).toBe('Fresh Title');
    expect(useEvalCenterStore.getState().reviewQueue).toEqual([
      expect.objectContaining({
        id: reviewItem.id,
        sessionTitle: 'Fresh Title',
        updatedAt: 200,
      }),
    ]);
  });

  it('enqueues a failure follow-up item from replay with the dedicated reason and source', async () => {
    invokeMock.mockResolvedValueOnce({
      ...reviewItem,
      reason: 'failure_followup',
      source: 'replay_failure',
      updatedAt: 300,
    });

    const result = await useEvalCenterStore.getState().enqueueFailureFollowup(
      'session-1',
      'Replay Failure Session',
    );

    expect(invokeMock).toHaveBeenCalledWith(EVALUATION_CHANNELS.REVIEW_QUEUE_ENQUEUE, {
      sessionId: 'session-1',
      sessionTitle: 'Replay Failure Session',
      reason: 'failure_followup',
      source: 'replay_failure',
    });
    expect(result).toEqual(expect.objectContaining({
      reason: 'failure_followup',
      source: 'replay_failure',
    }));
    expect(useEvalCenterStore.getState().reviewQueue[0]).toEqual(expect.objectContaining({
      reason: 'failure_followup',
      source: 'replay_failure',
      updatedAt: 300,
    }));
  });
});
