import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktopMocks = vi.hoisted(() => ({
  refreshRecentActivity: vi.fn(),
  searchSummaries: vi.fn(),
}));

vi.mock('../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    refreshRecentActivity: desktopMocks.refreshRecentActivity,
    searchSummaries: desktopMocks.searchSummaries,
  }),
}));

vi.mock('../../../src/host/desktop/workspaceArtifactIndexService', () => ({
  getWorkspaceArtifactIndexService: vi.fn(),
}));

vi.mock('../../../src/host/context/tokenOptimizer', () => ({
  estimateTokens: () => 1,
}));

import { searchWorkspaceActivity } from '../../../src/host/desktop/workspaceActivitySearchService';

describe('workspaceActivitySearchService on-demand refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopMocks.refreshRecentActivity.mockResolvedValue(undefined);
    desktopMocks.searchSummaries.mockResolvedValue([]);
  });

  it('refreshes desktop activity before searching desktop summaries', async () => {
    const result = await searchWorkspaceActivity('issue #42', {
      sinceHours: 6,
      sources: ['desktop'],
    });

    expect(desktopMocks.refreshRecentActivity).toHaveBeenCalledWith({
      lookbackHours: 6,
    });
    expect(desktopMocks.searchSummaries).toHaveBeenCalledWith('issue #42', {
      sinceHours: 6,
      limit: 8,
    });
    expect(result.items).toEqual([]);
  });
});
