import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_PROJECT_PINNED_METADATA_KEY, UNSORTED_PROJECT_ID } from '../../../../src/shared/contract/project';

const sendMock = vi.fn();

const dbState = {
  sessions: [] as Array<Record<string, any>>,
};

const assignSessionProject = vi.fn((sessionId: string, projectId: string) => {
  const session = dbState.sessions.find((item) => item.id === sessionId);
  if (session) session.projectId = projectId;
});

const dbMock = {
  createSession: vi.fn((session: Record<string, any>) => {
    dbState.sessions.push({ ...session });
  }),
  getSession: vi.fn((id: string, options?: { userId?: string | null }) =>
    dbState.sessions.find((session) => {
      if (session.id !== id) return false;
      if (options?.userId === undefined) return true;
      return options.userId === null ? session.userId == null : session.userId === options.userId;
    }) ?? null
  ),
  updateSession: vi.fn((id: string, updates: Record<string, unknown>) => {
    const session = dbState.sessions.find((item) => item.id === id);
    if (session) Object.assign(session, updates);
  }),
  getProjectRepo: vi.fn(() => ({ assignSessionProject })),
  logAuditEvent: vi.fn(),
};

const ensureProjectForWorkspace = vi.fn(async (workspacePath: string | undefined) => ({
  id: workspacePath?.trim() ? `proj_${workspacePath.trim()}` : UNSORTED_PROJECT_ID,
}));

vi.mock('../../../../src/host/platform', () => ({
  AppWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }],
  },
}));

vi.mock('../../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

vi.mock('../../../../src/host/services/project/projectService', () => ({
  getProjectService: () => ({ ensureProjectForWorkspace }),
}));

vi.mock('../../../../src/host/services/permissions/modes', () => ({
  getPermissionModeManager: () => ({
    initSessionMode: vi.fn(),
    markUnattendedSession: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/infra/toolCache', () => ({
  getToolCache: () => ({ clearSession: vi.fn() }),
}));

vi.mock('../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'user-1' }) }),
}));

vi.mock('../../../../src/host/services/infra/supabaseService', () => ({
  isSupabaseInitialized: () => false,
  getSupabase: () => null,
}));

async function makeManager() {
  const { SessionManager } = await import('../../../../src/host/services/infra/sessionManager');
  return new SessionManager();
}

describe('SessionManager project attribution', () => {
  beforeEach(() => {
    dbState.sessions = [];
    vi.clearAllMocks();
  });

  it('reassigns only unsorted sessions when a working directory is selected later', async () => {
    const manager = await makeManager();
    const unsortedSession = await manager.createSession({
      title: 'Unsorted session',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });
    expect(dbMock.getSession(unsortedSession.id)?.projectId ?? null).toBe(UNSORTED_PROJECT_ID);
    expect(dbMock.createSession).toHaveBeenCalledWith(expect.objectContaining({
      id: unsortedSession.id,
      projectId: UNSORTED_PROJECT_ID,
    }));

    const selectedDirectory = '/some/real/dir';
    await manager.updateSession(unsortedSession.id, { workingDirectory: selectedDirectory });

    const expectedProject = await ensureProjectForWorkspace(selectedDirectory);
    const reassignedProjectId = dbMock.getSession(unsortedSession.id)?.projectId;
    expect(reassignedProjectId).not.toBe(UNSORTED_PROJECT_ID);
    expect(reassignedProjectId).toBe(expectedProject.id);

    const explicitSession = await manager.createSession({
      title: 'Explicit project session',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
    });
    assignSessionProject(explicitSession.id, 'proj_explicit');

    await manager.updateSession(explicitSession.id, { workingDirectory: '/some/other/dir' });

    expect(dbMock.getSession(explicitSession.id)?.projectId).toBe('proj_explicit');
  });

  /**
   * N-MOBILE-DEFAULT-PROJECT（09-17 zj032 真宿主）：手机在「未分类」里建的会话没有工作目录，首轮运行
   * syncSessionWorkingDirectory 补上 <数据目录>-work，上面那条规则把它挪进自动项目 ⇒ 会话跑出手机的项目授权，
   * 命令回执/事件/历史全被网关拒，手机卡在「还没收到电脑确认」。钉住的会话不重算，整列 metadata 替换也不抹钉子。
   */
  it('keeps a pinned unsorted session in unsorted when the runtime fills in a working directory', async () => {
    const manager = await makeManager();
    const pinned = await manager.createSession({
      title: '新会话',
      modelConfig: { provider: 'openai', model: 'gpt-5' },
      metadata: { [SESSION_PROJECT_PINNED_METADATA_KEY]: true },
    });
    expect(dbMock.getSession(pinned.id)?.projectId).toBe(UNSORTED_PROJECT_ID);

    await manager.updateSession(pinned.id, { metadata: { unrelated: 1 } });
    await manager.updateSession(pinned.id, { workingDirectory: '/data-dir-work' });

    expect(dbMock.getSession(pinned.id)?.projectId).toBe(UNSORTED_PROJECT_ID);
    expect(ensureProjectForWorkspace).not.toHaveBeenCalledWith('/data-dir-work', expect.anything());
    expect(dbMock.getSession(pinned.id)?.metadata).toMatchObject({ unrelated: 1, [SESSION_PROJECT_PINNED_METADATA_KEY]: true });
  });
});
