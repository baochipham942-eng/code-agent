// ============================================================================
// PluginRegistry ↔ ToolSearch 插件工具可发现性（N-PLUGIN-ORIGIN-BUILTIN-HIDE-FU1）
// ----------------------------------------------------------------------------
// 不变量：默认 deferred 工具表面下，激活的第三方插件工具必须被 ToolSearch
// 搜得到、select 得到、进 getLoadedDeferredToolDefinitions；停用/注册失败
// 清理后不留 ghost；builtin 插件走静态索引的 unprefixed 工具名不重复登记。
// 全程真 PluginRegistry + 真 ToolSearchService 单例 + 真 protocol registry，
// 插件本体是磁盘 rootPath 的 fake（第三方语义，rootPath 不带 builtin: 前缀）。
// ============================================================================

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/host/services/cloud', () => ({
  getCloudConfigService: () => ({ getAllToolMeta: () => ({}) }),
}));

vi.mock('../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [] }),
}));

import { PluginRegistry } from '../../../src/host/plugins/pluginRegistry';
import { resetProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  getToolSearchService,
  resetToolSearchService,
} from '../../../src/host/services/toolSearch/toolSearchService';
import { getLoadedDeferredToolDefinitions, getDeferredToolsSummary } from '../../../src/host/tools/dispatch/toolDefinitions';
import type {
  LoadedPlugin,
  PluginAPI,
  PluginEntry,
  PluginManifest,
} from '../../../src/host/plugins/types';
import type { Tool } from '../../../src/host/tools/types';
import type { ToolModule } from '../../../src/host/protocol/tools';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeManifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
    // 第三方插件注册 fs 类工具必须声明 filesystem 权限(pluginRegistry.assertPermission)
    permissions: ['filesystem'],
    ...overrides,
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool, replies pong`,
    outputSchema: { type: 'string' as const },
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
    execute: async () => ({ success: true, output: 'pong' }),
  };
}

function makeToolModule(name: string): ToolModule {
  const schema = {
    name,
    description: `${name} module, replies pong`,
    outputSchema: { type: 'string' as const },
    inputSchema: { type: 'object' as const, properties: {} },
    category: 'fs' as const,
    permissionLevel: 'read' as const,
  };
  return {
    schema,
    createHandler: () =>
      ({
        schema,
        execute: async () => ({ ok: true }),
      } as unknown as ReturnType<ToolModule['createHandler']>),
  };
}

/** 注入磁盘 rootPath 的 fake 第三方插件，走 activatePlugin 生命周期，捕获 PluginAPI */
async function getPluginApi(
  reg: PluginRegistry,
  rootPath: string,
  manifest: PluginManifest,
  onActivate?: (api: PluginAPI) => void | Promise<void>,
): Promise<PluginAPI> {
  let captured: PluginAPI | undefined;
  const entry: PluginEntry = {
    activate: async (api) => {
      captured = api;
      await onActivate?.(api);
    },
  };
  const loadedPlugin: LoadedPlugin = {
    manifest,
    rootPath,
    state: 'inactive',
    entry,
    registeredTools: [],
  };
  // Bracket-access private map 仅为单测,生产代码绝不应这么用
  (reg as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(manifest.id, loadedPlugin);
  const ok = await reg.activatePlugin(manifest.id);
  if (!ok || !captured) throw new Error('plugin failed to activate');
  return captured;
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('PluginRegistry ↔ ToolSearch 插件工具可发现性', () => {
  let testDataDir: string;
  let pluginRoot: string;

  beforeEach(async () => {
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-plugin-toolsearch-test-'));
    process.env.CODE_AGENT_DATA_DIR = testDataDir;
    pluginRoot = path.join(testDataDir, 'plugins', 'neo-origin-demo');
    await fs.mkdir(pluginRoot, { recursive: true });
    resetProtocolRegistry();
    resetToolSearchService();
  });

  afterEach(async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    await fs.rm(testDataDir, { recursive: true, force: true });
  });

  it('① registerToolModule 路径：激活后能按工具名/插件 id/显示名搜到，select 加载并进 getLoadedDeferredToolDefinitions', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(
      reg,
      pluginRoot,
      makeManifest('neo-origin-demo', { displayName: 'Origin Demo' }),
      (captured) => captured.registerToolModule(makeToolModule('ping')),
    );
    expect(api).toBeDefined();

    const svc = getToolSearchService();

    // 按工具名搜（unprefixed 'ping' 与 prefixed 名都命中同一条）
    const byTool = await svc.searchTools('ping');
    expect(byTool.tools.map((t) => t.name)).toContain('neo-origin-demo:ping');
    expect(byTool.tools.find((t) => t.name === 'neo-origin-demo:ping')?.loadable).toBe(true);

    // 按插件 id 搜（alias）
    const byPluginId = await svc.searchTools('neo-origin-demo');
    expect(byPluginId.tools.map((t) => t.name)).toContain('neo-origin-demo:ping');

    // 按插件显示名搜（alias + 描述前缀）
    const byDisplayName = await svc.searchTools('origin demo');
    expect(byDisplayName.tools.map((t) => t.name)).toContain('neo-origin-demo:ping');

    // select 直选 → 加载，下一轮真的进工具表
    const selected = svc.selectTool('neo-origin-demo:ping');
    expect(selected.loadedTools).toEqual(['neo-origin-demo:ping']);
    expect(selected.tools[0]?.source).toBe('dynamic');
    expect(
      getLoadedDeferredToolDefinitions().map((d) => d.name),
    ).toContain('neo-origin-demo:ping');

    // deferred-tools 提示块按插件分组列出名字
    const summary = getDeferredToolsSummary();
    expect(summary).toContain('[plugin:neo-origin-demo] neo-origin-demo:ping');
  });

  it('①b registerTool（legacy）路径同一条链：可搜、可 select、进工具表', async () => {
    const reg = new PluginRegistry();
    await getPluginApi(
      reg,
      pluginRoot,
      makeManifest('neo-origin-demo', { displayName: 'Origin Demo' }),
      (captured) => captured.registerTool(makeTool('ping')),
    );

    const svc = getToolSearchService();
    const found = await svc.searchTools('ping');
    expect(found.tools.map((t) => t.name)).toContain('neo-origin-demo:ping');

    const selected = svc.selectTool('neo-origin-demo:ping');
    expect(selected.loadedTools).toEqual(['neo-origin-demo:ping']);
    expect(
      getLoadedDeferredToolDefinitions().map((d) => d.name),
    ).toContain('neo-origin-demo:ping');
  });

  it('② 停用后无 ghost：search 0 命中、select 加载 0、已加载集合与提示块同步清空', async () => {
    const reg = new PluginRegistry();
    await getPluginApi(
      reg,
      pluginRoot,
      makeManifest('neo-origin-demo'),
      (captured) => captured.registerToolModule(makeToolModule('ping')),
    );
    const svc = getToolSearchService();
    svc.selectTool('neo-origin-demo:ping');
    expect(svc.getLoadedDeferredTools()).toContain('neo-origin-demo:ping');

    expect(await reg.deactivatePlugin('neo-origin-demo')).toBe(true);

    const after = await svc.searchTools('ping');
    expect(after.totalCount).toBe(0);
    expect(after.tools).toEqual([]);
    const reselected = svc.selectTool('neo-origin-demo:ping');
    expect(reselected.tools).toEqual([]);
    expect(reselected.loadedTools).toEqual([]);
    // 已加载集合不残留停用插件的工具名
    expect(svc.getLoadedDeferredTools()).not.toContain('neo-origin-demo:ping');
    expect(svc.getPluginToolsMeta().map((m) => m.name)).toEqual([]);
    expect(getDeferredToolsSummary()).not.toContain('neo-origin-demo');
    expect(
      getLoadedDeferredToolDefinitions().map((d) => d.name),
    ).not.toContain('neo-origin-demo:ping');
  });

  it('②b unregisterTool 单工具注销后同步出搜索面', async () => {
    const reg = new PluginRegistry();
    const api = await getPluginApi(
      reg,
      pluginRoot,
      makeManifest('neo-origin-demo'),
      (captured) => captured.registerToolModule(makeToolModule('ping')),
    );
    api.unregisterTool('ping');

    const svc = getToolSearchService();
    const after = await svc.searchTools('ping');
    expect(after.totalCount).toBe(0);
    expect(svc.getPluginToolsMeta().map((m) => m.name)).toEqual([]);
  });

  it('③ 激活失败清理不留 ghost：activate 抛错后注册到一半的工具全部退出搜索面', async () => {
    const reg = new PluginRegistry();
    const manifest = makeManifest('neo-origin-demo');
    const entry: PluginEntry = {
      activate: async (api) => {
        api.registerToolModule(makeToolModule('ping'));
        api.registerTool(makeTool('pong'));
        throw new Error('boom');
      },
    };
    const loadedPlugin: LoadedPlugin = {
      manifest,
      rootPath: pluginRoot,
      state: 'inactive',
      entry,
      registeredTools: [],
    };
    (reg as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(manifest.id, loadedPlugin);
    await expect(reg.activatePlugin(manifest.id)).resolves.toBe(false);

    const svc = getToolSearchService();
    expect((await svc.searchTools('ping')).totalCount).toBe(0);
    expect((await svc.searchTools('pong')).totalCount).toBe(0);
    expect(svc.getPluginToolsMeta()).toEqual([]);
    expect(getDeferredToolsSummary()).not.toContain('neo-origin-demo');
  });

  it('④ builtin 插件的 unprefixed 静态名不重复登记：搜索命中仍是静态条目，pluginToolsMeta 不收', async () => {
    const reg = new PluginRegistry();
    // builtin 插件的注册形态：registerToolModule(module, { prefixWithPluginId: false })
    // 保留原工具名（静态 DEFERRED_TOOLS_META 已有同名条目，如 image_generate）
    await getPluginApi(
      reg,
      pluginRoot,
      makeManifest('builtin-like-plugin'),
      (captured) => captured.registerToolModule(makeToolModule('image_generate'), { prefixWithPluginId: false }),
    );

    const svc = getToolSearchService();
    expect(svc.getPluginToolsMeta().map((m) => m.name)).not.toContain('image_generate');
    const found = await svc.searchTools('image_generate');
    const matches = found.tools.filter((t) => t.name === 'image_generate');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.source).toBe('builtin');
    // 静态条目的可加载语义不变
    expect(svc.selectTool('image_generate').loadedTools).toEqual(['image_generate']);
  });
});
