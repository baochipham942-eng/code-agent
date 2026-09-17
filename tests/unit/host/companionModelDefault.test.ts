import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { getProviderHealthMonitor, resetProviderHealthMonitorForTests } from '../../../src/host/model/providerHealthMonitor';

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
    // 默认项才是唯一可能漏 key 的那条：它是拿 resolveSessionDefaultModelConfig() 的返回值比出来的，
    // 而那个返回值里带 apiKey / baseUrl / maxTokens
    const marked = models.find(model => model.isDefault);
    expect(Object.keys(marked ?? {}).sort()).toEqual(['isDefault', 'label', 'model', 'provider', 'providerLabel']);
  });
});

describe('爸配置形状：custom 供应商无 model + 列表首项已失败', () => {
  const original = structuredClone(settings.models);
  beforeEach(() => {
    resetProviderHealthMonitorForTests();
    settings.models = {
      default: 'custom-team-relay',
      providers: {
        longcat: {
          enabled: true,
          apiKeyConfigured: true,
          models: {
            'LongCat-2.0-Preview': { enabled: true },
            'LongCat-2.0': { enabled: true },
          },
        },
        'custom-team-relay': {
          enabled: true,
          apiKeyConfigured: true,
          displayName: '团队中转',
          models: {
            'gpt-5.5': { enabled: true, label: 'gpt-5.5' },
            'gpt-5.4-mini': { enabled: true, label: 'gpt-5.4-mini' },
          },
        },
      },
    };
  });
  afterEach(() => {
    settings.models = original;
    resetProviderHealthMonitorForTests();
  });

  it('isDefault 落在同供应商可用模型 gpt-5.5，不拿列表第一个 Preview', async () => {
    getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    const models = await readModels();
    expect(models[0]).toMatchObject({ provider: 'longcat', model: 'LongCat-2.0-Preview', recentlyFailed: true, failureKind: 'model' });
    expect(models.find(model => model.model === 'LongCat-2.0')).toMatchObject({ provider: 'longcat' });
    expect(models.find(model => model.model === 'LongCat-2.0')?.recentlyFailed).toBeUndefined();
    const marked = models.filter(model => model.isDefault);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ provider: 'custom-team-relay', model: 'gpt-5.5' });
  });

  it('供应商级 401 标整家；Preview 的模型级失败不连累 LongCat-2.0', async () => {
    getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    let models = await readModels();
    expect(models.find(model => model.model === 'LongCat-2.0-Preview')?.failureKind).toBe('model');
    expect(models.find(model => model.model === 'LongCat-2.0')?.recentlyFailed).toBeUndefined();

    resetProviderHealthMonitorForTests();
    getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Forbidden'), { status: 403 }),
    });
    models = await readModels();
    expect(models.filter(model => model.provider === 'longcat').every(model => model.failureKind === 'auth' && model.recentlyFailed)).toBe(true);
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.recentlyFailed).toBeUndefined();
  });
});
