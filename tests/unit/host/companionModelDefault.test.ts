import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelMarkFileStore } from '../../../src/host/model/availabilityMarkPersistence';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { projectGrant, type CompanionLibrary } from '../../../src/shared/contract/companionLibrary';
import type { ModelProviderSettings } from '../../../src/shared/contract/settings';

// 电脑的默认是 deepseek，但 moonshot 在桌面切换面板的 provider 常量序里排第一——
// 这个 fixture 就是 FB-141 的现场：列表顺序与电脑的选择相反。
const settings: { models: { default: string; providers: Record<string, ModelProviderSettings> } } = {
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
  getConfigService: () => ({ onSettingsUpdated: vi.fn(), getSettings: () => settings }),
}));

type MonitorModule = typeof import('../../../src/host/model/providerHealthMonitor');

let monitor: MonitorModule;
let CompanionLibraryService: typeof import('../../../src/host/services/companion/CompanionLibraryService')['CompanionLibraryService'];

// 单例 monitor 没有测试专用重置出口：重载模块图拿新单例。
// CompanionLibraryService 静态引用同一个 monitor 模块，必须一起重载，读到的才是同一个实例。
async function loadFreshModules(): Promise<void> {
  vi.resetModules();
  [monitor, { CompanionLibraryService }] = await Promise.all([
    import('../../../src/host/model/providerHealthMonitor'),
    import('../../../src/host/services/companion/CompanionLibraryService'),
  ]);
}

beforeEach(() => loadFreshModules());

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
    // 电脑默认可用：isDefault 就是真的默认，不带 defaultFallback（手机才标「电脑默认」）
    expect(marked[0].defaultFallback).toBeUndefined();
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
  });

  it('isDefault 落在同供应商可用模型 gpt-5.5，不拿已失败的 LongCat 模型', async () => {
    monitor.getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    const models = await readModels();
    expect(models.find(model => model.model === 'LongCat-2.0-Preview')).toMatchObject({ provider: 'longcat', recentlyFailed: true, failureKind: 'model' });
    expect(models.find(model => model.model === 'LongCat-2.0')).toMatchObject({ provider: 'longcat' });
    expect(models.find(model => model.model === 'LongCat-2.0')?.recentlyFailed).toBeUndefined();
    const marked = models.filter(model => model.isDefault);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ provider: 'custom-team-relay', model: 'gpt-5.5' });
  });

  it('供应商级 401 标整家；Preview 的模型级失败不连累 LongCat-2.0', async () => {
    monitor.getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Unsupported model'), { status: 400 }),
    });
    let models = await readModels();
    expect(models.find(model => model.model === 'LongCat-2.0-Preview')?.failureKind).toBe('model');
    expect(models.find(model => model.model === 'LongCat-2.0')?.recentlyFailed).toBeUndefined();

    await loadFreshModules();
    monitor.getProviderHealthMonitor().recordFailure('longcat', {
      model: 'LongCat-2.0-Preview',
      error: Object.assign(new Error('Forbidden'), { status: 403 }),
    });
    models = await readModels();
    expect(models.filter(model => model.provider === 'longcat').every(model => model.failureKind === 'auth' && model.recentlyFailed)).toBe(true);
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.recentlyFailed).toBeUndefined();
  });

  it('模型级停用标记跨重启仍在：回落继续跳过该模型（N-MOBILE-CONN-POLISH-R3 ④）', async () => {
    const file = path.join(tmpdir(), `model-marks-${randomUUID()}.json`);
    try {
      // 宿主第一次运行：标一个模型级停用（生产接线后 recordFailure 落盘）。
      monitor.armModelMarkPersistence(createModelMarkFileStore(file));
      monitor.getProviderHealthMonitor().recordFailure('longcat', {
        model: 'LongCat-2.0-Preview',
        error: Object.assign(new Error('Unsupported model'), { status: 400 }),
      });
      // 模拟重启：换新模块图（新单例、新 CompanionLibraryService），同一份存储回灌。
      await loadFreshModules();
      monitor.armModelMarkPersistence(createModelMarkFileStore(file));
      const models = await readModels();
      expect(models.find(model => model.model === 'LongCat-2.0-Preview')).toMatchObject({ provider: 'longcat', recentlyFailed: true, failureKind: 'model' });
      expect(models.find(model => model.model === 'LongCat-2.0')?.recentlyFailed).toBeUndefined();
      // 回落不落停用模型：isDefault 仍指向同供应商可用项（爸配置形状下是 custom-team-relay/gpt-5.5）。
      const marked = models.filter(model => model.isDefault);
      expect(marked).toHaveLength(1);
      expect(marked[0]).toMatchObject({ provider: 'custom-team-relay', model: 'gpt-5.5' });
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('429 连发把供应商打成 unavailable（无标记）：整家照标 recentlyFailed/network，默认挪走', async () => {
    // 429/超时不打可用性标记，但连发会把健康监控推到 unavailable——手机不能把路由已熔断的
    // 家当好选择（ai-review PR#1918 Important 1：电脑面板照实显示，手机也要标失败）。
    for (let i = 0; i < 4; i += 1) {
      monitor.getProviderHealthMonitor().recordFailure('longcat', {
        model: 'LongCat-2.0-Preview',
        error: Object.assign(new Error('Too many requests'), { status: 429 }),
      });
    }
    const models = await readModels();
    expect(models.filter(model => model.provider === 'longcat')
      .every(model => model.recentlyFailed === true && model.failureKind === 'network')).toBe(true);
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.isDefault).toBe(true);
  });

  // 模拟器验收 D1：Alpha 回 500×5 后成功 1 次，手机仍两行「最近连不上」、isDefault 挂在别家，
  // 而电脑端同时刻新建会话还是原默认——两端不一致。验收条款：成功一次立即清除该级标记。
  it('网络类熔断后成功 1 次：整家标记即清，isDefault 回到电脑默认（不依赖连续成功 3 次）', async () => {
    for (let i = 0; i < 4; i += 1) {
      monitor.getProviderHealthMonitor().recordFailure('custom-team-relay', {
        model: 'gpt-5.5',
        error: Object.assign(new Error('Internal Server Error'), { status: 500 }),
      });
    }
    let models = await readModels();
    // 熔断中：整家标 network，默认挪去未失败的 longcat
    expect(models.filter(model => model.provider === 'custom-team-relay')
      .every(model => model.recentlyFailed === true && model.failureKind === 'network')).toBe(true);
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.isDefault).toBeUndefined();
    // 成功一次立即清（此刻健康态仍 unavailable：要连续成功 3 次才 recovering，路由恢复节奏不变）
    expect(monitor.getProviderHealthMonitor().getHealth('custom-team-relay')?.status).toBe('unavailable');
    monitor.getProviderHealthMonitor().recordSuccess('custom-team-relay', 120, { model: 'gpt-5.5' });
    expect(monitor.getProviderHealthMonitor().getHealth('custom-team-relay')?.status).toBe('unavailable');
    models = await readModels();
    expect(models.filter(model => model.provider === 'custom-team-relay')
      .every(model => model.recentlyFailed === undefined)).toBe(true);
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.isDefault).toBe(true);
  });

  // 模拟器验收 O1：电脑默认用不了、默认回落到别的模型时，那个模型副标题曾写「电脑默认」——
  // 字面误导（电脑端真正默认没变）。回落选中的模型保留 isDefault（新会话预选），另标 defaultFallback。
  it('默认回落：isDefault 落到回落行并带 defaultFallback；真正默认行不再冒充', async () => {
    monitor.getProviderHealthMonitor().recordFailure('custom-team-relay', {
      model: 'gpt-5.5',
      error: Object.assign(new Error('Unauthorized'), { status: 401 }),
    });
    const models = await readModels();
    // 真正的默认：整家被标坏，不 isDefault
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5'))
      .toMatchObject({ recentlyFailed: true, failureKind: 'auth' });
    expect(models.find(model => model.provider === 'custom-team-relay' && model.model === 'gpt-5.5')?.isDefault).toBeUndefined();
    // 回落选中的：isDefault + defaultFallback（手机写「已为你换成这个」，不写「电脑默认」）
    const fallback = models.find(model => model.isDefault);
    expect(fallback).toMatchObject({ provider: 'longcat', defaultFallback: true });
    expect(models.filter(model => model.defaultFallback)).toHaveLength(1);
  });
});
