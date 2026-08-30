import { describe, expect, it, vi } from 'vitest';
import {
  normalizePluginCapabilityDeclaration,
  PluginCapabilitySurface,
} from '../../../src/host/plugins/pluginCapabilitySurface';
import type { PluginManifest } from '../../../src/host/plugins/types';

function manifest(
  id: string,
  declaration: Pick<PluginManifest, 'depends' | 'provides'> = {},
): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    main: 'index.js',
    ...declaration,
  };
}

describe('PluginCapabilitySurface', () => {
  it('normalizes omitted declarations without inventing product dependencies', () => {
    expect(normalizePluginCapabilityDeclaration(manifest('voice-core'))).toMatchObject({
      depends: [],
      provides: ['plugin:voice-core'],
    });
  });

  it('rejects missing dependencies, cycles, and duplicate providers through CapabilityUnitRuntime', () => {
    const surface = new PluginCapabilitySurface();
    expect(() => surface.validateGraph([
      manifest('consumer', { depends: ['plugin:missing'] }),
    ])).toThrow('plugin:consumer is missing dependencies: plugin:missing');

    expect(() => surface.validateGraph([
      manifest('a', { depends: ['plugin:b'] }),
      manifest('b', { depends: ['plugin:a'] }),
    ])).toThrow('capability dependency cycle: plugin:a -> plugin:b -> plugin:a');

    expect(() => surface.validateGraph([
      manifest('provider-a', { provides: ['plugin:provider-a', 'plugin:shared'] }),
      manifest('provider-b', { provides: ['plugin:provider-b', 'plugin:shared'] }),
    ])).toThrow('capability key "plugin:shared" has multiple providers');
  });

  it('loads in dependency order, records lifecycle, and refuses to unload an active provider', async () => {
    const lifecycle = vi.fn();
    const surface = new PluginCapabilitySurface(lifecycle);
    const active: string[] = [];
    const provider = manifest('provider');
    const consumer = manifest('consumer', { depends: ['plugin:provider'] });

    await surface.load(provider, () => { active.push('provider'); }, () => { active.splice(active.indexOf('provider'), 1); });
    await surface.load(consumer, () => { active.push('consumer'); }, () => { active.splice(active.indexOf('consumer'), 1); });

    await expect(surface.unload('provider')).rejects.toThrow(
      'plugin:provider cannot unload while dependents are active: plugin:consumer',
    );
    expect(active).toEqual(['provider', 'consumer']);

    await surface.unload('consumer');
    await surface.unload('provider');
    expect(active).toEqual([]);
    expect(lifecycle.mock.calls.map(([event]) => event.action)).toEqual([
      'loaded', 'loaded', 'failed', 'unloaded', 'unloaded',
    ]);
  });

  it('keeps legacy camelCase builtin IDs as exact plugin own-keys', () => {
    expect(() => new PluginCapabilitySurface().validateGraph([
      manifest('builtin.imageProcess'),
    ])).not.toThrow();
  });
});
