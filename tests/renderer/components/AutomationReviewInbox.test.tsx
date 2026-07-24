// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import type { ParkedApprovalInboxItem } from '../../../src/shared/contract/pendingApproval';

const listPendingReview = vi.fn<() => Promise<SessionAutomationRecord[]>>();
const listParkedApprovals = vi.fn<() => Promise<ParkedApprovalInboxItem[]>>();
const markReviewed = vi.fn().mockResolvedValue(null);
const switchSession = vi.fn().mockResolvedValue(undefined);
const ipcInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: () => listPendingReview(),
    listParkedApprovals: () => listParkedApprovals(),
    markReviewed: (id: string) => markReviewed(id),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invoke: (...args: unknown[]) => ipcInvoke(...args),
    isAvailable: () => true,
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

beforeEach(() => {
  // 默认两路都空；具体用例按需 override。
  listPendingReview.mockResolvedValue([]);
  listParkedApprovals.mockResolvedValue([]);
  ipcInvoke.mockResolvedValue(undefined);
});

function makeParked(over: Partial<ParkedApprovalInboxItem>): ParkedApprovalInboxItem {
  return {
    id: 'perm_req_1',
    sessionId: 'session-1',
    tool: 'mail_send',
    requestedAt: Date.now() - 120_000,
    status: 'pending',
    riskClass: 'external',
    ...over,
  };
}

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

  // B2 停车审批分组
  it('渲染「等待批准的操作」分组，批准回传 permissionResponse（同一 requestId）', async () => {
    listParkedApprovals.mockResolvedValueOnce([makeParked({ id: 'perm_req_1', sessionId: 'session-1' })]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
    });
    expect(screen.getByTestId('parked-approval-group')).toBeTruthy();

    fireEvent.click(screen.getByTestId('parked-approve'));
    await waitFor(() => {
      // 复用 agent:permission-response，requestId=停车行 id，sessionId 透传
      expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'perm_req_1', 'allow', 'session-1');
    });
  });

  it('拒绝回传 deny', async () => {
    listParkedApprovals.mockResolvedValueOnce([makeParked({ id: 'perm_req_2' })]).mockResolvedValue([]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-reject')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('parked-reject'));
    await waitFor(() => {
      expect(ipcInvoke).toHaveBeenCalledWith('agent:permission-response', 'perm_req_2', 'deny', 'session-1');
    });
  });

  it('orphaned 灰态不给操作按钮', async () => {
    listParkedApprovals.mockResolvedValue([makeParked({ id: 'perm_orph', status: 'orphaned' })]);
    render(<AutomationReviewInbox />);
    await waitFor(() => {
      expect(screen.getByTestId('parked-approval-item')).toBeTruthy();
    });
    expect(screen.queryByTestId('parked-approve')).toBeNull();
    expect(screen.queryByTestId('parked-reject')).toBeNull();
  });
});
