import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoadedPlugin, PluginManifest } from '../../../src/host/plugins/types';

const loaderMocks = vi.hoisted(() => ({
  loadPlugin: vi.fn(),
  discoverPlugins: vi.fn(async () => []),
  watchPluginsDir: vi.fn(() => () => undefined),
}));

vi.mock('../../../src/host/plugins/pluginLoader', () => loaderMocks);

import { PluginRegistry } from '../../../src/host/plugins/pluginRegistry';

function makePlugin(version: string): LoadedPlugin {
  const manifest: PluginManifest = {
    id: 'watcher-plugin',
    name: 'Watcher Plugin',
    version,
    main: 'index.js',
    surfaces: ['tools'],
  };
  return {
    manifest,
    rootPath: '/plugins/watcher-plugin',
    state: 'inactive',
    entry: { activate: async () => undefined },
    registeredTools: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('PluginRegistry watcher lifecycle ledger', () => {
  it('records watcher add, reload, and remove with plugin:<id> lifecycle calls', async () => {
    vi.useFakeTimers();
    let onAdded: ((pluginDir: string) => Promise<void>) | undefined;
    let onRemoved: ((pluginName: string) => Promise<void>) | undefined;
    const watch = vi.fn((
      added: (pluginDir: string) => void,
      removed: (pluginName: string) => void,
    ) => {
      onAdded = added as (pluginDir: string) => Promise<void>;
      onRemoved = removed as (pluginName: string) => Promise<void>;
      return () => undefined;
    });
    const lifecycle = vi.fn();
    const registry = new PluginRegistry(watch, lifecycle);
    (registry as unknown as { startWatching: () => void }).startWatching();

    loaderMocks.loadPlugin.mockResolvedValueOnce({ success: true, plugin: makePlugin('1.0.0') });
    await onAdded?.('/plugins/watcher-plugin');

    loaderMocks.loadPlugin.mockResolvedValueOnce({ success: true, plugin: makePlugin('2.0.0') });
    await onAdded?.('/plugins/watcher-plugin');
    await vi.advanceTimersByTimeAsync(500);

    await onRemoved?.('watcher-plugin');

    expect(lifecycle.mock.calls).toEqual([
      ['watcher-plugin', 'loaded', 'source=watcher; event=add; version=1.0.0'],
      ['watcher-plugin', 'loaded', 'source=watcher; event=reload; version=2.0.0'],
      ['watcher-plugin', 'unloaded', 'source=watcher; event=remove; version=2.0.0'],
    ]);
    expect(registry.getPlugin('watcher-plugin')).toBeUndefined();
  });

  it('keeps startup healthy plugins active while missing and cyclic plugins are skipped with failed ledger entries', async () => {
    const lifecycle = vi.fn();
    const registry = new PluginRegistry(vi.fn(() => () => undefined), lifecycle);
    const healthy = makePlugin('1.0.0');
    healthy.manifest.id = 'healthy';
    healthy.manifest.name = 'Healthy';
    healthy.rootPath = '/plugins/healthy';
    const missing = makePlugin('1.0.0');
    missing.manifest.id = 'missing-consumer';
    missing.manifest.name = 'Missing Consumer';
    missing.manifest.depends = ['plugin:absent'];
    missing.rootPath = '/plugins/missing-consumer';
    const cycleA = makePlugin('1.0.0');
    cycleA.manifest.id = 'cycle-a';
    cycleA.manifest.name = 'Cycle A';
    cycleA.manifest.depends = ['plugin:cycle-b'];
    cycleA.rootPath = '/plugins/cycle-a';
    const cycleB = makePlugin('1.0.0');
    cycleB.manifest.id = 'cycle-b';
    cycleB.manifest.name = 'Cycle B';
    cycleB.manifest.depends = ['plugin:cycle-a'];
    cycleB.rootPath = '/plugins/cycle-b';
    const plugins = (registry as unknown as { plugins: Map<string, LoadedPlugin> }).plugins;
    for (const plugin of [healthy, missing, cycleA, cycleB]) plugins.set(plugin.manifest.id, plugin);

    await expect((registry as unknown as { activateAll: () => Promise<void> }).activateAll())
      .resolves.toBeUndefined();

    expect(registry.getPlugin('healthy')?.state).toBe('active');
    for (const id of ['missing-consumer', 'cycle-a', 'cycle-b']) {
      expect(registry.getPlugin(id)?.state).toBe('error');
      expect(lifecycle).toHaveBeenCalledWith(id, 'failed', expect.stringContaining('source=startup'));
    }
  });

  it('skips a watcher-added plugin with a missing dependency without disturbing an active sibling', async () => {
    let onAdded: ((pluginDir: string) => Promise<void>) | undefined;
    const lifecycle = vi.fn();
    const registry = new PluginRegistry(vi.fn((added: (pluginDir: string) => void) => {
      onAdded = added as (pluginDir: string) => Promise<void>;
      return () => undefined;
    }), lifecycle);
    const healthy = makePlugin('1.0.0');
    healthy.manifest.id = 'healthy-watcher-sibling';
    healthy.manifest.name = 'Healthy Watcher Sibling';
    healthy.rootPath = '/plugins/healthy-watcher-sibling';
    (registry as unknown as { plugins: Map<string, LoadedPlugin> }).plugins.set(healthy.manifest.id, healthy);
    await registry.activatePlugin(healthy.manifest.id);
    (registry as unknown as { startWatching: () => void }).startWatching();

    const missing = makePlugin('1.0.0');
    missing.manifest.id = 'watcher-missing';
    missing.manifest.name = 'Watcher Missing';
    missing.manifest.depends = ['plugin:absent'];
    missing.rootPath = '/plugins/watcher-missing';
    loaderMocks.loadPlugin.mockResolvedValueOnce({ success: true, plugin: missing });
    await onAdded?.('/plugins/watcher-missing');

    expect(registry.getPlugin('healthy-watcher-sibling')?.state).toBe('active');
    expect(registry.getPlugin('watcher-missing')?.state).toBe('error');
    expect(lifecycle).toHaveBeenCalledWith(
      'watcher-missing',
      'failed',
      'source=watcher; event=add; activation failed',
    );
  });
});
