import { beforeEach, describe, expect, it, vi } from 'vitest';

const desktopMocks = vi.hoisted(() => ({
  ensureFreshData: vi.fn(),
  listTodoItems: vi.fn(),
}));

vi.mock('../../../src/host/desktop/desktopActivityUnderstandingService', () => ({
  getDesktopActivityUnderstandingService: () => ({
    ensureFreshData: desktopMocks.ensureFreshData,
    listTodoItems: desktopMocks.listTodoItems,
  }),
}));

vi.mock('../../../src/host/planning', () => ({
  publishPlanningStateToRenderer: vi.fn(),
}));

vi.mock('../../../src/host/planning/recoveredWorkOrchestrator', () => ({
  buildRecoveredWorkOrchestrationHint: vi.fn(),
  isContinuationLikeRequest: vi.fn(),
  recoverRecentWorkIntoPlanning: vi.fn(),
}));

vi.mock('../../../src/host/agent/todoParser', () => ({
  advanceTodoStatus: vi.fn(),
  mergeTodos: vi.fn(),
}));

vi.mock('../../../src/host/desktop/desktopActivityPlanningBridge', () => ({
  syncDesktopTasksToPlanningService: vi.fn(),
}));

vi.mock('../../../src/host/desktop/workspaceActivitySearchService', () => ({
  buildWorkspaceActivityContextBlock: vi.fn(),
}));

import { fetchDesktopTodoCandidates } from '../../../src/host/desktop/desktopContextBridge';

describe('desktopContextBridge on-demand refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopMocks.ensureFreshData.mockResolvedValue(undefined);
    desktopMocks.listTodoItems.mockReturnValue([]);
  });

  it('refreshes desktop activity on demand before a chat turn reads todo candidates', async () => {
    await fetchDesktopTodoCandidates({
      sinceHours: 6,
      limit: 3,
      maxAgeMs: 1_234,
    });

    expect(desktopMocks.ensureFreshData).toHaveBeenCalledWith(1_234);
    expect(desktopMocks.listTodoItems).toHaveBeenCalledWith({
      sinceHours: 6,
      limit: 3,
    });
  });
});
