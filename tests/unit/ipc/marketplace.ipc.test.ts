import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../src/shared/ipc';

// marketplace.ipc.ts：marketplace:* 通道。12 个 handler 全经 admin 门控包装
// （非 admin 一律拒），委派给 skills/marketplace 的 12 个函数并归一成
// MarketplaceResult。mock 这 12 个函数 + adminGuard，验证门控 / 成功映射 /
// manifest 读失败降级 / refresh-all 容错 / 安装记录回填 / 错误归一 errorResult。

const mp = vi.hoisted(() => ({
  listMarketplaces: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  addMarketplace: vi.fn(async () => ({ name: 'official' })),
  removeMarketplace: vi.fn(async () => {}),
  refreshMarketplace: vi.fn(async () => {}),
  getMarketplaceInfo: vi.fn(async () => ({ manifest: { description: 'desc', plugins: [{}, {}] } })),
  listAllPlugins: vi.fn(async (): Promise<unknown[]> => []),
  searchPlugins: vi.fn(async (): Promise<unknown[]> => []),
  installPlugin: vi.fn(async () => ({ installedSkills: [], installedCommands: [], installedPluginRoot: '/root' })),
  uninstallPlugin: vi.fn(async () => {}),
  listInstalledPlugins: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  enablePlugin: vi.fn(async () => {}),
  disablePlugin: vi.fn(async () => {}),
  isAdmin: true,
}));

vi.mock('../../../src/main/skills/marketplace', () => ({
  listMarketplaces: (...a: unknown[]) => mp.listMarketplaces(...a),
  addMarketplace: (...a: unknown[]) => mp.addMarketplace(...a),
  removeMarketplace: (...a: unknown[]) => mp.removeMarketplace(...a),
  refreshMarketplace: (...a: unknown[]) => mp.refreshMarketplace(...a),
  getMarketplaceInfo: (...a: unknown[]) => mp.getMarketplaceInfo(...a),
  listAllPlugins: (...a: unknown[]) => mp.listAllPlugins(...a),
  searchPlugins: (...a: unknown[]) => mp.searchPlugins(...a),
  installPlugin: (...a: unknown[]) => mp.installPlugin(...a),
  uninstallPlugin: (...a: unknown[]) => mp.uninstallPlugin(...a),
  listInstalledPlugins: (...a: unknown[]) => mp.listInstalledPlugins(...a),
  enablePlugin: (...a: unknown[]) => mp.enablePlugin(...a),
  disablePlugin: (...a: unknown[]) => mp.disablePlugin(...a),
}));
vi.mock('../../../src/main/ipc/adminGuard', () => ({ isCurrentUserAdmin: () => mp.isAdmin }));
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerMarketplaceHandlers } from '../../../src/main/ipc/marketplace.ipc';

type HandlerFn = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let handlers: Map<string, HandlerFn>;
const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!(null, ...args);

// 形状对齐真实 MarketplaceInfo 契约：source 是 MarketplaceSource 对象、lastUpdated 是 ISO string
const entry = (over: Record<string, unknown> = {}) => ({
  source: { source: 'github', repo: 'x/y' },
  installLocation: '/loc',
  lastUpdated: '2026-01-01T00:00:00.000Z',
  autoUpdate: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mp.isAdmin = true;
  mp.listMarketplaces.mockResolvedValue({});
  mp.addMarketplace.mockResolvedValue({ name: 'official' });
  mp.getMarketplaceInfo.mockResolvedValue({ manifest: { description: 'desc', plugins: [{}, {}] } });
  mp.listAllPlugins.mockResolvedValue([]);
  mp.searchPlugins.mockResolvedValue([]);
  mp.installPlugin.mockResolvedValue({ installedSkills: ['s'], installedCommands: ['c'], installedPluginRoot: '/root' });
  mp.listInstalledPlugins.mockResolvedValue({});
  handlers = new Map<string, HandlerFn>();
  registerMarketplaceHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
});

describe('admin 门控', () => {
  it('非 admin 调任意通道一律拒', async () => {
    mp.isAdmin = false;
    expect(await call(IPC_CHANNELS.MARKETPLACE_LIST)).toEqual({ success: false, error: 'Marketplace: Admin permission required' });
    expect(await call(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, 'p')).toEqual({ success: false, error: 'Marketplace: Admin permission required' });
    expect(mp.listMarketplaces).not.toHaveBeenCalled();
  });
});

describe('MARKETPLACE_LIST', () => {
  it('映射 config + manifest 信息', async () => {
    mp.listMarketplaces.mockResolvedValue({ official: entry() });
    const res = (await call(IPC_CHANNELS.MARKETPLACE_LIST)) as { success: boolean; data: unknown[] };
    expect(res.success).toBe(true);
    expect(res.data).toEqual([
      { name: 'official', description: 'desc', source: { source: 'github', repo: 'x/y' }, installLocation: '/loc', lastUpdated: '2026-01-01T00:00:00.000Z', pluginCount: 2, autoUpdate: true },
    ]);
  });

  it('manifest 读失败时降级为基本信息（pluginCount 0）', async () => {
    mp.listMarketplaces.mockResolvedValue({ broken: entry() });
    mp.getMarketplaceInfo.mockRejectedValue(new Error('no manifest'));
    const res = (await call(IPC_CHANNELS.MARKETPLACE_LIST)) as { data: Array<{ pluginCount: number; description?: string }> };
    expect(res.data[0].pluginCount).toBe(0);
    expect(res.data[0].description).toBeUndefined();
  });

  it('listMarketplaces 抛错 → errorResult', async () => {
    mp.listMarketplaces.mockRejectedValue(new Error('disk fail'));
    expect(await call(IPC_CHANNELS.MARKETPLACE_LIST)).toEqual({ success: false, error: 'disk fail' });
  });
});

describe('ADD / REMOVE / INFO', () => {
  it('ADD 装后回查 info 与 config 组装结果', async () => {
    mp.addMarketplace.mockResolvedValue({ name: 'official' });
    mp.listMarketplaces.mockResolvedValue({ official: entry({ source: { source: 'url', url: 'https://m' } }) });
    const res = (await call(IPC_CHANNELS.MARKETPLACE_ADD, 'https://m')) as { success: boolean; data: { name: string; source: unknown } };
    expect(res.data).toMatchObject({ name: 'official', source: { source: 'url', url: 'https://m' }, pluginCount: 2 });
    expect(mp.addMarketplace).toHaveBeenCalledWith('https://m');
  });

  it('REMOVE 委派并回 success', async () => {
    expect(await call(IPC_CHANNELS.MARKETPLACE_REMOVE, 'official')).toEqual({ success: true, data: undefined });
    expect(mp.removeMarketplace).toHaveBeenCalledWith('official');
  });

  it('INFO 组装 marketplace 信息', async () => {
    mp.listMarketplaces.mockResolvedValue({ official: entry() });
    const res = (await call(IPC_CHANNELS.MARKETPLACE_INFO, 'official')) as { data: { name: string } };
    expect(res.data).toMatchObject({ name: 'official', pluginCount: 2 });
  });
});

describe('MARKETPLACE_REFRESH', () => {
  it('指定 name → 只刷该 marketplace', async () => {
    await call(IPC_CHANNELS.MARKETPLACE_REFRESH, 'official');
    expect(mp.refreshMarketplace).toHaveBeenCalledWith('official');
    expect(mp.listMarketplaces).not.toHaveBeenCalled();
  });

  it('无 name → 刷新全部，单个失败被 warn 容错不中断', async () => {
    mp.listMarketplaces.mockResolvedValue({ a: entry(), b: entry() });
    mp.refreshMarketplace.mockRejectedValueOnce(new Error('a fail')).mockResolvedValueOnce(undefined);
    const res = await call(IPC_CHANNELS.MARKETPLACE_REFRESH);
    expect(res).toEqual({ success: true, data: undefined });
    // Codex 审计：断言刷的是 a 和 b，而非 refresh(undefined) 两次或同一个两次
    expect(mp.refreshMarketplace).toHaveBeenCalledWith('a');
    expect(mp.refreshMarketplace).toHaveBeenCalledWith('b');
    expect(mp.refreshMarketplace).toHaveBeenCalledTimes(2);
  });
});

describe('LIST_PLUGINS / SEARCH_PLUGINS', () => {
  const plugin = (over: Record<string, unknown> = {}) => ({
    plugin: { name: 'pdf', description: 'd', source: 'src', types: [], skills: [], commands: [], tags: [], version: '1', author: 'alice', ...over },
    marketplace: 'official',
  });

  it('LIST_PLUGINS 标注安装状态 + 作者归一', async () => {
    mp.listAllPlugins.mockResolvedValue([plugin(), plugin({ name: 'excel', author: { name: 'bob' } })]);
    mp.listInstalledPlugins.mockResolvedValue({ 'pdf@official': { isEnabled: true } });
    const res = (await call(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS)) as { data: Array<{ name: string; isInstalled: boolean; isEnabled?: boolean; author?: string }> };
    expect(res.data[0]).toMatchObject({ name: 'pdf', isInstalled: true, isEnabled: true, author: 'alice' });
    expect(res.data[1]).toMatchObject({ name: 'excel', isInstalled: false, author: 'bob' }); // object author → name
  });

  it('LIST_PLUGINS 按 marketplaceId 过滤', async () => {
    mp.listAllPlugins.mockResolvedValue([plugin(), plugin({ name: 'other' })].map((p, i) => ({ ...p, marketplace: i === 0 ? 'official' : 'third' })));
    const res = (await call(IPC_CHANNELS.MARKETPLACE_LIST_PLUGINS, 'official')) as { data: unknown[] };
    expect(res.data).toHaveLength(1);
  });

  it('作者为无 name 的对象 → undefined', async () => {
    mp.searchPlugins.mockResolvedValue([plugin({ author: { homepage: 'x' } })]);
    const res = (await call(IPC_CHANNELS.MARKETPLACE_SEARCH_PLUGINS, 'pdf')) as { data: Array<{ author?: string }> };
    expect(res.data[0].author).toBeUndefined();
  });
});

describe('INSTALL / UNINSTALL / ENABLE / DISABLE', () => {
  it('INSTALL 成功且有安装记录 → 回填 plugin', async () => {
    mp.installPlugin.mockResolvedValue({ installedSkills: ['s1'], installedCommands: ['c1'], installedPluginRoot: '/r' });
    mp.listInstalledPlugins.mockResolvedValue({ 'pdf@official': { plugin: 'pdf', marketplace: 'official', scope: 'user', isEnabled: true, installedAt: '2026-01-02T00:00:00.000Z', pluginRoot: '/r', types: [], skills: [], commands: [] } });
    const res = (await call(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, 'pdf@official')) as { success: boolean; plugin?: { name: string } };
    expect(res.success).toBe(true);
    expect(res.plugin).toMatchObject({ name: 'pdf', marketplace: 'official' });
  });

  it('INSTALL 成功但无安装记录 → plugin undefined', async () => {
    mp.listInstalledPlugins.mockResolvedValue({});
    const res = (await call(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, 'ghost')) as { success: boolean; plugin?: unknown };
    expect(res.success).toBe(true);
    expect(res.plugin).toBeUndefined();
  });

  it('INSTALL 失败 → success:false 带 error', async () => {
    mp.installPlugin.mockRejectedValue(new Error('install boom'));
    expect(await call(IPC_CHANNELS.MARKETPLACE_INSTALL_PLUGIN, 'pdf')).toEqual({ success: false, error: 'install boom' });
  });

  it('UNINSTALL 委派带 scope', async () => {
    await call(IPC_CHANNELS.MARKETPLACE_UNINSTALL_PLUGIN, 'pdf', 'project');
    expect(mp.uninstallPlugin).toHaveBeenCalledWith('pdf', { scope: 'project' });
  });

  it('ENABLE / DISABLE 委派', async () => {
    expect(await call(IPC_CHANNELS.MARKETPLACE_ENABLE_PLUGIN, 'pdf')).toEqual({ success: true, data: undefined });
    expect(mp.enablePlugin).toHaveBeenCalledWith('pdf');
    expect(await call(IPC_CHANNELS.MARKETPLACE_DISABLE_PLUGIN, 'pdf')).toEqual({ success: true, data: undefined });
    expect(mp.disablePlugin).toHaveBeenCalledWith('pdf');
  });
});

describe('LIST_INSTALLED', () => {
  it('按 scope 过滤', async () => {
    mp.listInstalledPlugins.mockResolvedValue({
      'a@m': { plugin: 'a', marketplace: 'm', scope: 'user', isEnabled: true, installedAt: '2026-01-02T00:00:00.000Z', pluginRoot: '/a', types: [], skills: [], commands: [] },
      'b@m': { plugin: 'b', marketplace: 'm', scope: 'project', isEnabled: false, installedAt: '2026-01-03T00:00:00.000Z', pluginRoot: '/b', types: [], skills: [], commands: [] },
    });
    const userOnly = (await call(IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED, 'user')) as { data: Array<{ name: string }> };
    expect(userOnly.data).toHaveLength(1);
    expect(userOnly.data[0].name).toBe('a');
    const all = (await call(IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED, 'all')) as { data: unknown[] };
    expect(all.data).toHaveLength(2);
  });

  it('listInstalledPlugins 抛错 → errorResult', async () => {
    mp.listInstalledPlugins.mockRejectedValue(new Error('read fail'));
    expect(await call(IPC_CHANNELS.MARKETPLACE_LIST_INSTALLED)).toEqual({ success: false, error: 'read fail' });
  });
});
