import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/main/tools/types';

const desktopMocks = vi.hoisted(() => ({
  refreshRecentActivity: vi.fn(),
  searchSummaries: vi.fn(),
}));

const artifactIndexMocks = vi.hoisted(() => ({
  refreshRecentArtifacts: vi.fn(),
  searchArtifacts: vi.fn(),
}));

vi.mock('../../../../src/main/memory/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    refreshRecentActivity: desktopMocks.refreshRecentActivity,
    searchSummaries: desktopMocks.searchSummaries,
  }),
}));

vi.mock('../../../../src/main/memory/workspaceArtifactIndexService', () => ({
  getWorkspaceArtifactIndexService: () => ({
    refreshRecentArtifacts: artifactIndexMocks.refreshRecentArtifacts,
    searchArtifacts: artifactIndexMocks.searchArtifacts,
  }),
}));

import { workspaceActivitySearchTool } from '../../../../src/main/tools/memory/workspaceActivitySearch';

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: process.cwd(),
    requestPermission: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as ToolContext;
}

describe('workspaceActivitySearchTool', () => {
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
  });

  it('aggregates desktop summaries and indexed office artifacts into one result set', async () => {
    desktopMocks.refreshRecentActivity.mockResolvedValue(undefined);
    desktopMocks.searchSummaries.mockResolvedValue([
      {
        score: 0.93,
        snippet: '继续处理 issue #42，并修改 memory plan。',
        summary: {
          sliceKey: 'slice-1',
          fromMs: Date.parse('2026-03-14T09:00:00+08:00'),
          toMs: Date.parse('2026-03-14T09:30:00+08:00'),
          lastCapturedAtMs: Date.parse('2026-03-14T09:28:00+08:00'),
          summary: '09:00-09:30 主要在跟进 issue #42 和 memory plan。',
          salientSubjects: ['issue #42', 'memory plan'],
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
          title: 'Re: Issue #42 follow-up',
          snippet: 'alice@example.com | Work / Inbox',
          score: 0.87,
          timestampMs: Date.parse('2026-03-14T10:00:00+08:00'),
          metadata: {
            artifactKey: 'mail:Work:Inbox:101',
            threadKey: 'issue #42 follow-up',
            threadSubject: 'Issue #42 follow-up',
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
            notesPreview: 'review issue #42',
          },
        },
        {
          id: 'mem-rem-1',
          sourceKind: 'reminders',
          title: 'Issue #42 follow-up draft',
          snippet: 'Work',
          score: 0.82,
          timestampMs: null,
          metadata: {
            artifactKey: 'reminder:rem-1',
            notesPreview: 'finish issue #42 follow-up draft',
          },
        },
      ],
      warnings: [],
      countsBySource: { mail: 1, calendar: 1, reminders: 1 },
    });

    const result = await workspaceActivitySearchTool.execute(
      { query: 'issue #42', limit: 6 },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(desktopMocks.refreshRecentActivity).toHaveBeenCalledTimes(1);
    expect(artifactIndexMocks.refreshRecentArtifacts).toHaveBeenCalledTimes(1);
    expect(artifactIndexMocks.searchArtifacts).toHaveBeenCalledWith('issue #42', expect.objectContaining({
      limit: 6,
      sinceHours: 24,
    }));

    const payload = result.result as {
      items: Array<{ source: string; title: string }>;
      warnings: string[];
      countsBySource: Record<string, number>;
    };
    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((item) => item.source)).toEqual(
      expect.arrayContaining(['desktop', 'mail']),
    );
    expect(payload.countsBySource).toMatchObject({
      desktop: 1,
      mail: 1,
      calendar: 1,
      reminders: 1,
    });
    expect(payload.warnings).toEqual([]);
    expect(result.output).toContain('[desktop]');
    expect(result.output).toContain('[mail+calendar+reminders]');
  });

  it('returns partial results when artifact indexing yields warnings', async () => {
    desktopMocks.searchSummaries.mockResolvedValue([]);
    artifactIndexMocks.refreshRecentArtifacts.mockResolvedValue({
      indexedArtifacts: 1,
      createdArtifacts: 0,
      updatedArtifacts: 1,
      unchangedArtifacts: 0,
      generatedAtMs: Date.now(),
      warnings: ['mail: mail unavailable'],
      bySource: { mail: 0, calendar: 1, reminders: 0 },
    });
    artifactIndexMocks.searchArtifacts.mockReturnValue({
      items: [
        {
          id: 'mem-cal-1',
          sourceKind: 'calendar',
          title: 'RFC-005 alignment',
          snippet: 'Work | 03/14 16:00',
          score: 0.81,
          timestampMs: Date.parse('2026-03-14T16:00:00+08:00'),
          metadata: { artifactKey: 'calendar:cal-1' },
        },
      ],
      warnings: [],
      countsBySource: { mail: 0, calendar: 1, reminders: 0 },
    });

    const result = await workspaceActivitySearchTool.execute(
      { query: 'RFC-005', sources: ['mail', 'calendar'] },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const payload = result.result as {
      items: Array<{ source: string; title: string }>;
      warnings: string[];
      countsBySource: Record<string, number>;
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.source).toBe('calendar');
    expect(payload.warnings[0]).toContain('mail: mail unavailable');
    expect(payload.countsBySource).toMatchObject({
      mail: 0,
      calendar: 1,
    });
    expect(result.output).toContain('部分来源读取失败');
  });
});
