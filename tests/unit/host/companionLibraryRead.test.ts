import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { projectGrant } from '../../../src/shared/contract/companionLibrary';
import type { StoredSession } from '../../../src/host/protocol/types';

const listSessions = vi.hoisted(() => vi.fn<(limit: number, offset: number) => StoredSession[]>());
const getSession = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn((): { id: string; name: string; workspacePath?: string | null }[] => [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({}),
    listSessions: (limit: number, offset: number) => listSessions(limit, offset),
    getSession,
    getProjectRepo: () => ({ listProjects }),
  }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'owner-1' }) }),
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => ({}) }),
}));
vi.mock('../../../src/shared/modelRuntime', () => ({
  buildRuntimeModelOptions: () => [],
}));
vi.mock('../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'custom-team-relay', model: 'LongCat-2.0' }),
}));

import { CompanionLibraryService } from '../../../src/host/services/companion/CompanionLibraryService';

function session(id: string, projectId: string | undefined): StoredSession {
  return {
    id,
    title: id,
    userId: 'owner-1',
    modelConfig: { provider: 'openai', model: 'gpt' },
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    status: 'idle',
    projectId,
  } as StoredSession;
}

function seedSessions(count: number): StoredSession[] {
  return Array.from({ length: count }, (_, index) => session(`s${index}`, index % 2 === 0 ? 'one' : 'two'));
}

describe('companion library listing compiles access SQL once', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let library: CompanionLibraryService;
  let prepareCount = 0;
  let originalPrepare: Database.Database['prepare'];

  beforeEach(() => {
    db = new Database(':memory:');
    originalPrepare = db.prepare.bind(db);
    prepareCount = 0;
    db.prepare = ((sql: string) => {
      prepareCount += 1;
      return originalPrepare(sql);
    }) as Database.Database['prepare'];
    gateway = new CompanionGateway(db);
    library = new CompanionLibraryService(gateway, () => false);
    listSessions.mockReset();
    getSession.mockReset();
    listProjects.mockReturnValue([{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]);
  });
  afterEach(() => { db.close(); });

  async function readLibrary(count: number, deviceId: string) {
    const rows = seedSessions(count);
    listSessions.mockImplementation((limit, offset) => rows.slice(offset, offset + limit));
    const access = vi.spyOn(gateway, 'canAccessSession');
    const before = prepareCount;
    const result = await library.read(deviceId, { kind: 'library', offset: 0 });
    return { result, prepares: prepareCount - before, access, deviceId };
  }

  it('filters by grants then paginates without compiling SQL once per session', async () => {
    const deviceId = gateway.issueDeviceCredential([projectGrant('one')]).deviceId;
    const small = await readLibrary(80, deviceId);
    expect(small.result).toEqual(expect.objectContaining({
      nextOffset: null,
      sessions: expect.any(Array),
    }));
    expect((small.result as { sessions: { id: string; projectId: string | null }[] }).sessions).toHaveLength(40);
    expect((small.result as { sessions: { projectId: string | null }[] }).sessions.every(row => row.projectId === 'one')).toBe(true);
    expect(small.access).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();

    small.access.mockClear();
    const large = await readLibrary(800, deviceId);
    expect((large.result as { sessions: unknown[] }).sessions).toHaveLength(L.syncPageSize);
    expect((large.result as { nextOffset: number | null }).nextOffset).toBe(L.syncPageSize);
    expect(large.access).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(large.prepares, 'prepare count must not grow linearly with session count').toBe(small.prepares);
    expect(large.prepares).toBeLessThan(20);
  });

  it('hides a session queued for cleanup even when the store still lists it', async () => {
    const deviceId = gateway.issueDeviceCredential([projectGrant('one')]).deviceId;
    gateway.forgetSession('s0');
    const { result, access } = await readLibrary(4, deviceId);
    const ids = (result as { sessions: { id: string }[] }).sessions.map(row => row.id);
    expect(ids).not.toContain('s0');
    expect(ids).toContain('s2');
    expect(access).not.toHaveBeenCalled();
  });

  // fix5-③（2026-09-15 build 36 反馈⑦）：同名项目用路径消歧，手机侧标签需要工作目录。
  it('projects carry workspacePath for the phone-side disambiguation label (null when absent)', async () => {
    const deviceId = gateway.issueDeviceCredential([projectGrant('one'), projectGrant('two')]).deviceId;
    listProjects.mockReturnValue([
      { id: 'one', name: 'workspace', workspacePath: '/Users/neo/Downloads/ai/workspace' },
      { id: 'two', name: 'workspace', workspacePath: null },
    ]);
    const { result } = await readLibrary(2, deviceId);
    const projects = (result as { projects: { id: string; workspacePath?: string | null; canCreate: boolean }[] }).projects;
    expect(projects).toEqual([
      { id: 'one', name: 'workspace', workspacePath: '/Users/neo/Downloads/ai/workspace', canCreate: true },
      { id: 'two', name: 'workspace', workspacePath: null, canCreate: false, createBlocked: 'no_workspace' },
    ]);
  });

  // N-COMPANION-CANCREATE-SEMANTICS（build 45 真机：未分类 workspace_path 为空，手机按授权放行，点了必失败）
  it('canCreate 答「此刻能不能建」：有授权但没工作目录 = 不能建并说为什么；没授权另报一个原因', async () => {
    // s1 属于 two：设备只持有这条会话的授权，项目 two 因此被列出、但没有项目授权
    const deviceId = gateway.issueDeviceCredential([projectGrant('one'), projectGrant('unsorted'), 's1']).deviceId;
    listProjects.mockReturnValue([
      { id: 'one', name: 'One', workspacePath: '/w/one' },
      { id: 'unsorted', name: '未分类', workspacePath: '' },
      { id: 'two', name: 'Two', workspacePath: '/w/two' },
    ]);
    // 前提自证：unsorted 确实在授权里——否则「不能建」可能只是没授权带出来的
    expect(gateway.grants(deviceId)).toContain(projectGrant('unsorted'));
    const { result } = await readLibrary(4, deviceId);
    const byId = Object.fromEntries((result as { projects: { id: string; canCreate: boolean; createBlocked?: string }[] }).projects.map(p => [p.id, p]));
    expect(byId.one).toMatchObject({ canCreate: true });
    expect(byId.one.createBlocked).toBeUndefined();
    expect(byId.unsorted).toMatchObject({ canCreate: false, createBlocked: 'no_workspace' });
    expect(byId.two).toMatchObject({ canCreate: false, createBlocked: 'not_granted' });
  });

  // N-MOBILE-RUNFAIL-REASON 附带：胶囊显示的必须是这次真正会执行的模型（build 45：写 glm-5.3-flash，实跑默认模型）
  it('会话报下一次执行真正会用的模型：没切换过跟电脑默认，切换过跟 override，不报建会话时的快照列', async () => {
    const deviceId = gateway.issueDeviceCredential([projectGrant('one')]).deviceId;
    const plain = { ...session('plain', 'one'), modelConfig: { provider: 'custom-glm-coding', model: 'glm-5.3-flash' } } as StoredSession;
    const switched = { ...session('switched', 'one'), modelConfig: { provider: 'custom-glm-coding', model: 'glm-5.3-flash' },
      metadata: { modelOverride: { provider: 'deepseek', model: 'deepseek-chat', setAt: 1 } } } as StoredSession;
    listSessions.mockImplementation((_limit, offset) => offset === 0 ? [plain, switched] : []);
    const result = await library.read(deviceId, { kind: 'library', offset: 0 }) as { sessions: { id: string; provider: string; model: string }[] };
    const byId = Object.fromEntries(result.sessions.map(row => [row.id, row]));
    expect(byId.plain).toMatchObject({ provider: 'custom-team-relay', model: 'LongCat-2.0' });
    expect(byId.switched).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
