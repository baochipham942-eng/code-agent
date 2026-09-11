import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import { projectGrant } from '../../../src/shared/contract/companionLibrary';
import type { StoredSession } from '../../../src/host/protocol/types';

const listSessions = vi.hoisted(() => vi.fn<(limit: number, offset: number) => StoredSession[]>());
const getSession = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn(() => [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }]));

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
  getConfigService: () => ({ getSettings: () => ({}) }),
}));
vi.mock('../../../src/shared/modelRuntime', () => ({
  buildRuntimeModelOptions: () => [],
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
});
