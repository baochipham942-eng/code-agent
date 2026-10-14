// @vitest-environment jsdom
// 页首「待过目」tile 与收件箱标题都走 countPendingReview（按任务折算）。
// 同一任务两条记录 → 两处都显示 1。
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAutomationRecord } from '../../../src/shared/contract/sessionAutomation';
import { countPendingReviewByTask } from '../../../src/shared/cronRunDigest';

const records: SessionAutomationRecord[] = [
  {
    id: 'review-a',
    sourceSessionId: null,
    type: 'cron',
    status: 'active',
    title: '每日周报',
    resultSessionId: 'run-a',
    config: { pendingReview: { resultSessionId: 'run-a', at: 1 } },
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: 'review-b',
    sourceSessionId: null,
    type: 'cron',
    status: 'active',
    title: '每日周报',
    resultSessionId: 'run-b',
    config: { pendingReview: { resultSessionId: 'run-b', at: 2 } },
    createdAt: 1,
    updatedAt: 1,
  },
];

const sessionsById = {
  'run-a': { origin: { kind: 'cron' as const, id: 'job-1' } },
  'run-b': { origin: { kind: 'cron' as const, id: 'job-1' } },
};

vi.mock('../../../src/renderer/services/sessionAutomationClient', () => ({
  sessionAutomationClient: {
    listPendingReview: () => Promise.resolve(records),
    listParkedApprovals: () => Promise.resolve([]),
    countPendingReview: () => Promise.resolve(countPendingReviewByTask(records, sessionsById)),
    markReviewed: () => Promise.resolve(null),
  },
}));

vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: {
    invokeDomain: vi.fn().mockResolvedValue({
      scopes: { unattended: { currentCost: 0, maxBudget: 1, usagePercentage: 0 } },
    }),
    invoke: vi.fn().mockResolvedValue(undefined),
    isAvailable: () => true,
  },
}));

vi.mock('../../../src/renderer/services/cronClient', () => ({
  cronClient: {
    listJobs: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue(null),
    getExecutions: vi.fn().mockResolvedValue([]),
    getRecentExecutions: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../../src/renderer/components/features/cron/CronFeaturedTemplates', () => ({
  CronFeaturedTemplates: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobList', () => ({
  CronJobList: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobDetail', () => ({
  CronJobDetail: () => null,
}));
vi.mock('../../../src/renderer/components/features/cron/CronJobEditor', () => ({
  CronJobEditor: () => null,
}));
vi.mock('../../../src/renderer/components/features/settings/WebModeBanner', () => ({
  WebModeBanner: () => null,
}));

import { CronCenterPanel } from '../../../src/renderer/components/features/cron/CronCenterPanel';
import { useCronStore } from '../../../src/renderer/stores/cronStore';

beforeEach(() => {
  useCronStore.setState({
    jobs: [],
    stats: { jobsByStatus: { running: 0 }, successRate: 100 } as never,
    latestExecutions: {},
    executionsByJobId: {},
    selectedJobId: null,
    filterMode: 'all',
    searchQuery: '',
    isLoading: false,
    isEditorOpen: false,
    editingJobId: null,
    error: null,
    recentExecutions: [],
  });
});

afterEach(() => {
  cleanup();
});

describe('pending review count parity', () => {
  it('shows 1 on the tile and the inbox title when two records belong to one task', async () => {
    expect(countPendingReviewByTask(records, sessionsById)).toBe(1);
    render(<CronCenterPanel onClose={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId('cron-status-pending').querySelector('.text-2xl')?.textContent).toBe('1');
      expect(screen.getByTestId('automation-review-inbox-title').textContent).toContain('1 条待过目');
    });
    expect(screen.getAllByTestId('automation-review-item')).toHaveLength(2);
    expect(screen.getByTestId('automation-review-inbox-title').textContent).not.toContain('2 条');
  });
});
