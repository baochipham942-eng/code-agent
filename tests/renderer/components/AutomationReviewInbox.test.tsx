// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';

const listPendingReview = vi.fn<() => Promise<SessionAutomationRecord[]>>();
const markReviewed = vi.fn().mockResolvedValue(null);
const switchSession = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: () => listPendingReview(),
    markReviewed: (id: string) => markReviewed(id),
  },
}));

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (selector: (state: { switchSession: typeof switchSession }) => unknown) =>
    selector({ switchSession }),
}));

import { AutomationReviewInbox } from '../../../src/renderer/components/features/cron/AutomationReviewInbox';

function makeRecord(over: Partial<SessionAutomationRecord>): SessionAutomationRecord {
  return {
    id: 'auto-1',
    sourceSessionId: 'src-1',
    type: 'cron',
    status: 'active',
    title: '英语单词',
    config: { pendingReview: { resultSessionId: 'result-1', at: 1700000000000 } },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AutomationReviewInbox', () => {
  it('无待审时不渲染', async () => {
    listPendingReview.mockResolvedValue([]);
    const { container } = render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(listPendingReview).toHaveBeenCalled();
    });
    expect(container.querySelector('[data-testid="automation-review-inbox"]')).toBeNull();
  });

  it('渲染待审条目，已过目调 markReviewed 并刷新', async () => {
    listPendingReview.mockResolvedValueOnce([makeRecord({})]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('automation-review-item')).toBeTruthy();
    });
    expect(screen.getByText('英语单词')).toBeTruthy();

    fireEvent.click(screen.getByTestId('automation-review-done'));
    await waitFor(() => {
      expect(markReviewed).toHaveBeenCalledWith('auto-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('automation-review-item')).toBeNull();
    });
  });

  it('查看结果：标记已读并跳结果会话', async () => {
    listPendingReview.mockResolvedValue([makeRecord({})]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByText('查看结果')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('查看结果'));
    await waitFor(() => {
      expect(markReviewed).toHaveBeenCalledWith('auto-1');
      expect(switchSession).toHaveBeenCalledWith('result-1');
    });
  });
});
