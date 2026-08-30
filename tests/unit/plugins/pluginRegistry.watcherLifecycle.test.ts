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
});
