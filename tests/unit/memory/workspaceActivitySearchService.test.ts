import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktopMocks = vi.hoisted(() => ({
  refreshRecentActivity: vi.fn(),
  searchSummaries: vi.fn(),
}));

const artifactIndexMocks = vi.hoisted(() => ({
  refreshRecentArtifacts: vi.fn(),
  searchArtifacts: vi.fn(),
}));

vi.mock('../../../src/main/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    refreshRecentActivity: desktopMocks.refreshRecentActivity,
    searchSummaries: desktopMocks.searchSummaries,
  }),
}));

vi.mock('../../../src/main/memory/workspaceArtifactIndexService', () => ({
  getWorkspaceArtifactIndexService: () => ({
    refreshRecentArtifacts: artifactIndexMocks.refreshRecentArtifacts,
    searchArtifacts: artifactIndexMocks.searchArtifacts,
  }),
}));

import {
  buildWorkspaceActivityContextBlock,
  searchWorkspaceActivity,
} from '../../../src/main/memory/workspaceActivitySearchService';

describe('workspaceActivitySearchService', () => {
  beforeEach(() => {
    desktopMocks.refreshRecentActivity.mockReset();
    desktopMocks.searchSummaries.mockReset();
    artifactIndexMocks.refreshRecentArtifacts.mockReset();
    artifactIndexMocks.searchArtifacts.mockReset();

    artifactIndexMocks.refreshRecentArtifacts.mockResolvedValue({
      indexedArtifacts: 0,
      createdArtifacts: 0,
      updatedArtifacts: 0,
      unchangedArtifacts: 0,
      generatedAtMs: Date.now(),
      warnings: [],
      bySource: { mail: 0, calendar: 0, reminders: 0 },
    });
    artifactIndexMocks.searchArtifacts.mockReturnValue({
      items: [],
      warnings: [],
      countsBySource: { mail: 0, calendar: 0, reminders: 0 },
    });
  });

  it('builds a compact workspace context block for relevant user requests', async () => {
    desktopMocks.searchSummaries.mockResolvedValue([
      {
        score: 0.91,
        snippet: '最近在 Issue #42 和 memory plan 上连续工作。',
        summary: {
          sliceKey: 'slice-1',
          fromMs: Date.parse('2026-03-14T09:00:00+08:00'),
          toMs: Date.parse('2026-03-14T09:30:00+08:00'),
          lastCapturedAtMs: Date.parse('2026-03-14T09:28:00+08:00'),
          summary: '09:00-09:30 主要在跟进 Issue #42。',
          salientSubjects: ['Issue #42', 'memory plan'],
          topApps: [{ appName: 'Cursor', count: 4 }],
          domains: ['github.com'],
        },
      },
    ]);
    artifactIndexMocks.searchArtifacts.mockReturnValue({
      items: [
        {
          id: 'mem-mail-1',
          sourceKind: 'mail',
          title: 'Issue #42 follow-up',
          snippet: 'alice@example.com | Work / Inbox',
          score: 0.83,
          timestampMs: Date.parse('2026-03-14T10:00:00+08:00'),
          metadata: {
            kind: 'workspace_artifact',
            sourceKind: 'mail',
            artifactKey: 'mail:Work:Inbox:101',
            title: 'Issue #42 follow-up',
            indexedAtMs: Date.now(),
          },
        },
      ],
      warnings: [],
      countsBySource: { mail: 1, calendar: 0, reminders: 0 },
    });

    const block = await buildWorkspaceActivityContextBlock(
      '继续推进 issue #42，把 memory plan 补完',
      { refreshDesktop: false, refreshArtifacts: false, limit: 4 },
    );

    expect(block).toContain('当前用户请求和最近工作区活动存在以下相关线索');
    expect(block).toContain('[desktop]');
    expect(block).toContain('[mail]');
    expect(block).toContain('Issue #42');
  });

  it('suppresses generic prompts and respects context item caps', async () => {
    desktopMocks.searchSummaries.mockResolvedValue([
      {
        score: 0.91,
        snippet: '最近在 Issue #42 和 memory plan 上连续工作。',
        summary: {
          sliceKey: 'slice-1',
          fromMs: Date.parse('2026-03-14T09:00:00+08:00'),
          toMs: Date.parse('2026-03-14T09:30:00+08:00'),
          lastCapturedAtMs: Date.parse('2026-03-14T09:28:00+08:00'),
          summary: '09:00-09:30 主要在跟进 Issue #42。',
          salientSubjects: ['Issue #42', 'memory plan'],
          topApps: [{ appName: 'Cursor', count: 4 }],
          domains: ['github.com'],
        },
      },
      {
        score: 0.88,
        snippet: '继续处理 memory plan 收尾。',
        summary: {
          sliceKey: 'slice-2',
          fromMs: Date.parse('2026-03-14T10:00:00+08:00'),
          toMs: Date.parse('2026-03-14T10:30:00+08:00'),
          lastCapturedAtMs: Date.parse('2026-03-14T10:28:00+08:00'),
          summary: '10:00-10:30 主要在完成 memory plan。',
          salientSubjects: ['memory plan'],
          topApps: [{ appName: 'Cursor', count: 3 }],
          domains: ['github.com'],
        },
      },
    ]);

    const genericBlock = await buildWorkspaceActivityContextBlock('继续推进一下', {
      refreshDesktop: false,
      refreshArtifacts: false,
    });
    expect(genericBlock).toBeNull();

    const specificBlock = await buildWorkspaceActivityContextBlock(
      '继续推进 issue #42 和 memory plan',
      { refreshDesktop: false, refreshArtifacts: false, contextMaxItems: 1 },
    );
    expect(specificBlock).toContain('[desktop]');
    expect(specificBlock?.match(/\n1\./g)?.length ?? 0).toBe(1);
    expect(specificBlock).not.toContain('\n2.');
  });

  it('filters weak matches when minScore is provided', async () => {
    desktopMocks.searchSummaries.mockResolvedValue([
      {
        score: 0.41,
        snippet: '弱相关 desktop summary',
        summary: {
          sliceKey: 'slice-2',
          fromMs: Date.parse('2026-03-14T11:00:00+08:00'),
          toMs: Date.parse('2026-03-14T11:30:00+08:00'),
          lastCapturedAtMs: Date.parse('2026-03-14T11:28:00+08:00'),
          summary: '11:00-11:30 浏览了一些文档。',
          salientSubjects: ['docs'],
          topApps: [{ appName: 'Chrome', count: 3 }],
          domains: ['example.com'],
        },
      },
    ]);

    const result = await searchWorkspaceActivity('docs', {
      refreshDesktop: false,
      refreshArtifacts: false,
      minScore: 0.5,
    });

    expect(result.items).toHaveLength(0);
    expect(result.countsBySource.desktop).toBe(0);
  });

  it('merges related office artifacts into one cross-source result', async () => {
    artifactIndexMocks.searchArtifacts.mockReturnValue({
      items: [
        {
          id: 'mem-mail-1',
          sourceKind: 'mail',
          title: 'Re: Issue #42 follow-up',
          snippet: 'alice@example.com | Work / Inbox',
          score: 0.87,
          timestampMs: Date.parse('2026-03-14T10:00:00+08:00'),
          metadata: {
            artifactKey: 'mail:Work:Inbox:101',
            threadKey: 'issue #42 follow-up',
            threadSubject: 'Issue #42 follow-up',
            attachmentNames: ['proposal-v3.pdf'],
          },
        },
        {
          id: 'mem-cal-1',
          sourceKind: 'calendar',
          title: 'Issue #42 review',
          snippet: 'Work | Meeting Room A',
          score: 0.84,
          timestampMs: Date.parse('2026-03-14T15:00:00+08:00'),
          metadata: {
            artifactKey: 'calendar:cal-1',
            notesPreview: '需要 review issue #42 的最终方案',
          },
        },
        {
          id: 'mem-rem-1',
          sourceKind: 'reminders',
          title: 'Issue #42 follow-up draft',
          snippet: 'Work',
          score: 0.82,
          timestampMs: Date.parse('2026-03-14T18:00:00+08:00'),
          metadata: {
            artifactKey: 'reminder:rem-1',
            notesPreview: '跟进 issue #42 draft',
          },
        },
      ],
      warnings: [],
      countsBySource: { mail: 1, calendar: 1, reminders: 1 },
    });

    const result = await searchWorkspaceActivity('issue #42', {
      refreshDesktop: false,
      refreshArtifacts: false,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      source: 'mail',
      title: 'Re: Issue #42 follow-up',
    });
    expect(result.items[0]?.metadata).toMatchObject({
      mergedSources: ['mail', 'calendar', 'reminders'],
      mergedCount: 3,
    });
    expect(result.items[0]?.snippet).toContain('[calendar] Issue #42 review');
    expect(result.items[0]?.snippet).toContain('[reminders] Issue #42 follow-up draft');
    expect(result.countsBySource).toMatchObject({
      mail: 1,
      calendar: 1,
      reminders: 1,
    });
  });
});
