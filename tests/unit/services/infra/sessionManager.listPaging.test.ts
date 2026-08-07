// ============================================================================
// SessionManager.listSessions 分页透传（2026-08-07 工单：侧栏历史会话够不到）。
// 仓储层本就有 limit/offset，本测试钉住 host 层的接线：
// - 默认吃 SESSION_LIST_PAGE_SIZE（不再硬编码 50 字面量）；
// - limit/offset 原样透传到 db.listSessions；
// - archivedOnly 走 db.listArchivedSessions 独立分页，不碰混合列表。
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_LIST_PAGE_SIZE } from '../../../../src/shared/constants';

const sendMock = vi.fn();
const ensureProjectForWorkspaceMock = vi.fn();
const supabaseLimitMock = vi.fn();

const dbMock = {
  listSessions: vi.fn(() => [] as unknown[]),
  listArchivedSessions: vi.fn(() => [] as unknown[]),
  getSession: vi.fn(() => null),
  createSession: vi.fn(),
  createSessionWithId: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
  getRecentMessages: vi.fn(() => [] as unknown[]),
  logAuditEvent: vi.fn(),
};

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({
    clearSession: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({
    getCurrentUser: () => ({ id: 'user-1' }),
  }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => true,
  getSupabase: () => ({
    from: () => ({
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit: supabaseLimitMock,
    }),
  }),
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({
    ensureProjectForWorkspace: ensureProjectForWorkspaceMock,
  }),
}));

describe('SessionManager.listSessions 分页透传', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 云端同步是 listSessions 的后台副作用，置空让其早退，不干扰断言
    supabaseLimitMock.mockResolvedValue({ data: [], error: null });
    ensureProjectForWorkspaceMock.mockResolvedValue({ id: 'unsorted' });
  });

  it('不传分页参数：吃常量默认页大小、offset 0、不含归档', async () => {
    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    await manager.listSessions();

    expect(dbMock.listSessions).toHaveBeenCalledWith(SESSION_LIST_PAGE_SIZE, 0, false, 'user-1');
    expect(dbMock.listArchivedSessions).not.toHaveBeenCalled();
  });

  it('limit/offset 原样透传到 db.listSessions', async () => {
    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    await manager.listSessions({ limit: 10, offset: 20, includeArchived: true });

    expect(dbMock.listSessions).toHaveBeenCalledWith(10, 20, true, 'user-1');
    expect(dbMock.listArchivedSessions).not.toHaveBeenCalled();
  });

  it('archivedOnly：走 db.listArchivedSessions 独立分页，不碰混合列表', async () => {
    const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
    const manager = new SessionManager();

    await manager.listSessions({ archivedOnly: true, limit: 5, offset: 15 });

    expect(dbMock.listArchivedSessions).toHaveBeenCalledWith(5, 15, 'user-1');
    expect(dbMock.listSessions).not.toHaveBeenCalled();
  });
});
