import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { projectGrant, type CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import { SESSION_PROJECT_PINNED_METADATA_KEY, UNSORTED_PROJECT_ID } from '../../../src/shared/contract/project';

/**
 * 爸 2026-09-16 真机：电脑上只有「未分类」一个项目，工作目录为空；build 46 按「无目录即不可建」把它挡了 ⇒
 * 手机上一个会话都建不了。桌面端在未分类里新建对话从不需要目录（运行时兜底应用工作目录），手机端要一致；
 * 真有名字、却没设目录的普通项目照旧不可建。
 */
const projects = vi.hoisted(() => new Map<string, { id: string; name: string; workspacePath: string | null; status: string }>());
const createSession = vi.hoisted(() => vi.fn());

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({}),
    listSessions: () => [],
    getSession: () => null,
    getProjectRepo: () => ({ listProjects: () => [...projects.values()], getProject: (id: string) => projects.get(id) ?? null }),
  }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({ getAuthService: () => ({ getCurrentUser: () => ({ id: 'owner-1' }) }) }));
vi.mock('../../../src/host/services/core/configService', () => ({ getConfigService: () => ({ getSettings: () => ({}) }) }));
vi.mock('../../../src/shared/modelRuntime', () => ({
  buildRuntimeModelOptions: () => [{ provider: 'longcat', model: 'LongCat-2.0', label: 'LongCat-2.0', providerLabel: 'LongCat' }],
}));
vi.mock('../../../src/host/services/core/sessionDefaults', () => ({ resolveSessionDefaultModelConfig: () => ({ provider: 'longcat', model: 'LongCat-2.0' }) }));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({ getSessionManager: () => ({ createSession }) }));

import { CompanionLibraryService } from '../../../src/host/services/companion/CompanionLibraryService';

function setup() {
  const db = new Database(':memory:');
  const gateway = new CompanionGateway(db);
  // 命令占位/回执落库是网关的事，与「能不能建」无关：这里只让写入照常执行
  vi.spyOn(gateway, 'commitMutation').mockImplementation(((_command: unknown, write: () => void) => write()) as never);
  const service = new CompanionLibraryService(gateway, () => false);
  const device = gateway.issueDeviceCredential([projectGrant(UNSORTED_PROJECT_ID), projectGrant('blank')]);
  const create = (projectId: string) => service.mutate({
    version: 1, deviceId: device.deviceId, scopeEpoch: device.scopeEpoch, commandId: `cmd-${projectId}`,
    sessionId: `project:${projectId}`, action: 'session.create', payload: { title: '新会话', provider: 'longcat', model: 'LongCat-2.0' },
  } as never);
  return { db, service, device, create };
}

describe('手机在「未分类」里新建会话与桌面端一致', () => {
  beforeEach(() => {
    projects.clear();
    projects.set(UNSORTED_PROJECT_ID, { id: UNSORTED_PROJECT_ID, name: '未分类', workspacePath: null, status: 'idle' });
    projects.set('blank', { id: 'blank', name: '没设目录的项目', workspacePath: null, status: 'active' });
    createSession.mockReset();
    createSession.mockImplementation(async (options: { id: string; commit: (write: () => void) => void }) => {
      options.commit(() => {});
      return { id: options.id, projectId: UNSORTED_PROJECT_ID };
    });
  });

  it('库里：未分类可建；没设目录的普通项目仍标 no_workspace', async () => {
    const { db, service, device } = setup();
    try {
      const library = await service.read(device.deviceId, { kind: 'library', offset: 0 }) as CompanionLibrary;
      const byId = Object.fromEntries(library.projects.map(p => [p.id, p]));
      expect(byId[UNSORTED_PROJECT_ID]).toMatchObject({ canCreate: true });
      expect(byId[UNSORTED_PROJECT_ID].createBlocked).toBeUndefined();
      expect(byId.blank).toMatchObject({ canCreate: false, createBlocked: 'no_workspace' });
    } finally { db.close(); }
  });

  it('命令：未分类真的建出来，且不带工作目录（交给运行时兜底）；没设目录的普通项目照旧拒', async () => {
    const { db, create } = setup();
    try {
      await expect(create(UNSORTED_PROJECT_ID)).resolves.toMatchObject({ sessionId: expect.stringMatching(/^mobile-/) });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession.mock.calls[0][0].workingDirectory).toBeUndefined();
      // 归属钉住：首轮运行兜底补目录时不许把它重算出这台手机的项目授权（09-17 模拟器实测落进 <数据目录>-work 自动项目）
      expect(createSession.mock.calls[0][0].metadata[SESSION_PROJECT_PINNED_METADATA_KEY]).toBe(true);
      await expect(create('blank')).rejects.toThrow('COMPANION_PROJECT_UNAVAILABLE');
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});
