import { describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { projectGrant, type CompanionLibrary } from '../../../src/shared/contract/companionLibrary';

// 电脑的默认是 deepseek，但 moonshot 在桌面切换面板的 provider 常量序里排第一——
// 这个 fixture 就是 FB-141 的现场：列表顺序与电脑的选择相反。
const settings = {
  models: {
    default: 'deepseek',
    providers: {
      moonshot: { enabled: true, apiKeyConfigured: true },
      deepseek: { enabled: true, apiKeyConfigured: true, model: 'deepseek-chat' },
      longcat: { enabled: true },
    },
  },
};

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    getDb: () => ({}),
    listSessions: () => [],
    getSession: () => null,
    getProjectRepo: () => ({ listProjects: () => [{ id: 'one', name: 'One' }] }),
  }),
}));
vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'owner-1' }) }),
}));
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => settings }),
}));

import { CompanionLibraryService } from '../../../src/host/services/companion/CompanionLibraryService';

async function readModels() {
  const db = new Database(':memory:');
  try {
    const gateway = new CompanionGateway(db);
    const service = new CompanionLibraryService(gateway, () => false);
    const deviceId = gateway.issueDeviceCredential([projectGrant('one')]).deviceId;
    const result = await service.read(deviceId, { kind: 'library', offset: 0 }) as CompanionLibrary;
    return result.models;
  } finally { db.close(); }
}

describe('companion model list marks the computer default', () => {
  it('marks the model the computer itself would use, not the first of the list', async () => {
    const models = await readModels();
    // 顺序原样保留：默认项只能靠 isDefault 认出来，认不出就会落到列表第一项
    expect(models[0]).toMatchObject({ provider: 'moonshot' });
    const marked = models.filter(model => model.isDefault);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('still lists only providers the computer can actually use', async () => {
    const models = await readModels();
    // longcat enabled 但没 key：手机拿到它就是一个必然 401 的选项
    expect(models.some(model => model.provider === 'longcat')).toBe(false);
    expect(models.some(model => model.provider === 'moonshot')).toBe(true);
  });

  it('ships only the four display fields, never provider credentials', async () => {
    const models = await readModels();
    const plain = models.find(model => !model.isDefault);
    expect(Object.keys(plain ?? {}).sort()).toEqual(['label', 'model', 'provider', 'providerLabel']);
  });
});
