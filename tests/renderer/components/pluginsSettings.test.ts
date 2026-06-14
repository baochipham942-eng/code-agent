import { describe, expect, it } from 'vitest';
import type { InstalledPlugin, MarketplacePluginEntry } from '../../../src/shared/contract/marketplace';
import {
  buildPluginVisibilityAssessment,
  filterMarketplacePlugins,
  getPluginSpec,
  getPluginTrustSummary,
  PLUGIN_COMPLETENESS_ROWS,
} from '../../../src/renderer/components/features/settings/tabs/PluginsSettings';

const catalog: MarketplacePluginEntry[] = [
  {
    name: 'browser-tools',
    marketplace: 'core',
    source: './browser-tools',
    description: 'Browser automation helpers',
    skills: ['browser'],
    commands: ['inspect'],
    tags: ['browser', 'desktop'],
    isInstalled: true,
    isEnabled: true,
  },
  {
    name: 'ops-tools',
    marketplace: 'core',
    source: './ops-tools',
    description: 'Operations helpers',
    skills: ['ops'],
    tags: ['admin'],
    isInstalled: true,
    isEnabled: false,
  },
  {
    name: 'design-tools',
    marketplace: 'community',
    source: './design-tools',
    description: 'Design workflow helpers',
    skills: ['design'],
    tags: ['design'],
  },
];

const installed: InstalledPlugin[] = [
  {
    name: 'browser-tools',
    marketplace: 'core',
    scope: 'user',
    isEnabled: true,
    installedAt: '2026-05-19T00:00:00.000Z',
    skills: ['browser'],
    commands: ['inspect'],
  },
  {
    name: 'ops-tools',
    marketplace: 'core',
    scope: 'project',
    isEnabled: false,
    projectPath: '/repo',
    installedAt: '2026-05-19T00:00:00.000Z',
    skills: ['ops'],
    commands: [],
  },
];

describe('PluginsSettings helpers', () => {
  it('builds stable plugin specs', () => {
    expect(getPluginSpec(catalog[0]!)).toBe('browser-tools@core');
  });

  it('splits enabled runtime plugins from admin-only plugin records', () => {
    const visibility = buildPluginVisibilityAssessment({ catalog, installed });

    expect(visibility.installedTotal).toBe(2);
    expect(visibility.enabledTotal).toBe(1);
    expect(visibility.catalogTotal).toBe(3);
    expect(visibility.userVisible.map((item) => item.spec)).toEqual(['browser-tools@core']);
    expect(visibility.adminOnly.map((item) => item.spec)).toEqual([
      'ops-tools@core',
      'design-tools@community',
    ]);
    expect(visibility.adminOnly.map((item) => item.kind)).toEqual(['installed', 'available']);
  });

  it('filters catalog plugins by marketplace and searchable metadata', () => {
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'community', query: '' }).map((item) => item.name)).toEqual([
      'design-tools',
    ]);
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'all', query: 'desktop' }).map((item) => item.name)).toEqual([
      'browser-tools',
    ]);
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'all', query: 'ops' }).map((item) => item.name)).toEqual([
      'ops-tools',
    ]);
  });

  it('keeps management complete while marking governance as partial', () => {
    expect(PLUGIN_COMPLETENESS_ROWS.filter((row) => row.status === 'complete').map((row) => row.area)).toEqual([
      '市场源',
      '发现',
      '安装',
      '生命周期',
      '权限',
    ]);
    expect(PLUGIN_COMPLETENESS_ROWS.find((row) => row.area === '治理')?.status).toBe('partial');
  });

  it('summarizes plugin trust fields and treats missing declarations as unknown risk', () => {
    expect(getPluginTrustSummary(catalog[0]!)).toContain('1 skills');
    expect(getPluginTrustSummary(catalog[0]!)).toContain('1 commands');
    expect(getPluginTrustSummary(catalog[1]!)).toContain('未声明 permissions');
    expect(getPluginTrustSummary(catalog[1]!)).toContain('未知风险');
  });
});
