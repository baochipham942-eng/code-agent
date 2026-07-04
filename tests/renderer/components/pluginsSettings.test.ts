import { describe, expect, it } from 'vitest';
import type { InstalledPlugin, MarketplacePluginEntry } from '../../../src/shared/contract/marketplace';
import { zh } from '../../../src/renderer/i18n/zh';
import {
  ALMA_FEATURED_PLUGIN_REGISTRY,
  adaptAlmaPluginToCodeAgentSpec,
  getAlmaFeaturedPlugins,
  getAlmaPluginAdapterSpecs,
  getAlmaPluginSlashCommandCandidates,
  normalizeAlmaPluginRegistryFeatured,
} from '../../../src/shared/constants/almaPluginRegistry';
import {
  buildPluginVisibilityAssessment,
  filterMarketplacePlugins,
  getPluginRuntimeReadiness,
  getPluginSpec,
  isPluginRuntimeVisible,
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
  {
    name: 'codex-auth',
    marketplace: 'core',
    scope: 'user',
    isEnabled: true,
    installedAt: '2026-05-19T00:00:00.000Z',
    types: ['provider'],
    skills: [],
    commands: [],
  },
];

describe('PluginsSettings helpers', () => {
  const pluginsText = zh.settings.plugins;

  it('builds stable plugin specs', () => {
    expect(getPluginSpec(catalog[0]!)).toBe('browser-tools@core');
  });

  it('splits enabled runtime plugins from admin-only plugin records', () => {
    const visibility = buildPluginVisibilityAssessment({ catalog, installed });

    expect(visibility.installedTotal).toBe(3);
    expect(visibility.enabledTotal).toBe(2);
    expect(visibility.catalogTotal).toBe(3);
    expect(visibility.userVisible.map((item) => item.spec)).toEqual(['browser-tools@core']);
    expect(visibility.adminOnly.map((item) => item.spec)).toEqual([
      'ops-tools@core',
      'codex-auth@core',
      'design-tools@community',
    ]);
    expect(visibility.adminOnly.map((item) => item.kind)).toEqual(['installed', 'installed', 'available']);
    expect(visibility.adminOnly.find((item) => item.spec === 'codex-auth@core')?.reason).toContain('adapter');
  });

  it('separates plugin lifecycle enablement from runtime visibility', () => {
    expect(getPluginRuntimeReadiness(installed[0]!)).toBe('runtime_ready');
    expect(isPluginRuntimeVisible(installed[0]!)).toBe(true);

    expect(getPluginRuntimeReadiness(installed[1]!)).toBe('disabled');
    expect(isPluginRuntimeVisible(installed[1]!)).toBe(false);

    expect(getPluginRuntimeReadiness(installed[2]!)).toBe('adapter_pending');
    expect(isPluginRuntimeVisible(installed[2]!)).toBe(false);
  });

  it('filters catalog plugins by marketplace and searchable metadata', () => {
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'community', query: '' }).map((item) => item.name)).toEqual([
      'design-tools',
    ]);
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'all', query: 'desktop' }).map((item) => item.name)).toEqual([
      'browser-tools',
    ]);
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'all', query: 'inspect' }).map((item) => item.name)).toEqual([
      'browser-tools',
    ]);
    expect(filterMarketplacePlugins({ plugins: catalog, marketplace: 'all', query: 'ops' }).map((item) => item.name)).toEqual([
      'ops-tools',
    ]);
  });

  it('keeps management complete while marking governance as partial', () => {
    expect(PLUGIN_COMPLETENESS_ROWS.filter((row) => row.status === 'complete').map((row) => row.area)).toEqual([
      pluginsText.completeness.rows[0]!.area,
      pluginsText.completeness.rows[1]!.area,
      pluginsText.completeness.rows[2]!.area,
      pluginsText.completeness.rows[3]!.area,
      pluginsText.completeness.rows[4]!.area,
    ]);
    expect(PLUGIN_COMPLETENESS_ROWS.find((row) => row.area === pluginsText.completeness.rows[6]!.area)?.status).toBe('partial');
  });

  it('completeness rows 是带 status 数据字段的 i18n 数组：zh/en 行数与 status 序列必须一致', async () => {
    const { en } = await import('../../../src/renderer/i18n/en');
    const zhRows = pluginsText.completeness.rows;
    const enRows = en.settings.plugins.completeness.rows;
    expect(enRows.length).toBe(zhRows.length);
    expect(enRows.map((row) => row.status)).toEqual(zhRows.map((row) => row.status));
  });

  it('keeps Alma featured plugins as installable managed assets instead of skill plugins', () => {
    expect(getAlmaFeaturedPlugins().map((plugin) => plugin.id)).toEqual([
      'token-counter',
      'catppuccin-theme',
      'openai-codex-auth',
      'cursor-auth',
    ]);
    expect(ALMA_FEATURED_PLUGIN_REGISTRY.map((plugin) => plugin.kind)).toEqual([
      'ui',
      'theme',
      'provider',
      'provider',
    ]);
    expect(ALMA_FEATURED_PLUGIN_REGISTRY.every((plugin) => plugin.riskNote.length > 0)).toBe(true);
  });

  it('normalizes Alma featured plugin registry items while preserving the reviewed fallback', () => {
    expect(normalizeAlmaPluginRegistryFeatured().map((plugin) => plugin.id)).toEqual([
      'token-counter',
      'catppuccin-theme',
      'openai-codex-auth',
      'cursor-auth',
    ]);

    expect(normalizeAlmaPluginRegistryFeatured({
      version: '1.0.0',
      plugins: [
        {
          id: 'token-counter',
          name: 'Token Counter',
          type: ['ui'],
          author: { name: 'Alma Team' },
          featured: true,
        },
        {
          id: 'codex-auth',
          name: 'Codex Auth',
          type: 'provider',
          featured: true,
        },
        {
          id: 'slash-tools',
          name: 'Slash Tools',
          type: 'command',
          featured: true,
          commands: ['inspect'],
        },
        {
          id: 'unlisted-command',
          name: 'Unlisted Command',
          type: 'command',
          featured: false,
          commands: ['hidden'],
        },
        {
          id: 'legacy',
          name: 'Legacy',
          type: 'legacy',
          featured: true,
        },
      ],
    }).map((plugin) => ({ id: plugin.id, kind: plugin.kind }))).toEqual([
      { id: 'token-counter', kind: 'ui' },
      { id: 'codex-auth', kind: 'provider' },
      { id: 'slash-tools', kind: 'command' },
    ]);
  });

  it('only exposes command-type Alma plugins as slash command candidates', () => {
    expect(getAlmaPluginSlashCommandCandidates({
      version: '1.0.0',
      plugins: [
        {
          id: 'token-counter',
          name: 'Token Counter',
          type: 'ui',
          featured: true,
        },
        {
          id: 'openai-codex-auth',
          name: 'OpenAI Codex Auth',
          type: 'provider',
          featured: true,
        },
      ],
    })).toEqual([]);

    expect(getAlmaPluginSlashCommandCandidates({
      version: '1.0.0',
      plugins: [
        {
          id: 'slash-tools',
          name: 'Slash Tools',
          type: 'commands',
          featured: true,
          commands: ['inspect', 'inspect', 'repair'],
        },
      ],
    })).toEqual([
      {
        id: 'slash-tools',
        name: 'Slash Tools',
        commands: ['inspect', 'repair'],
      },
    ]);
  });

  it('adapts Alma plugin types into explicit code-agent safety surfaces', () => {
    expect(getAlmaPluginAdapterSpecs().map((spec) => ({
      id: spec.id,
      surface: spec.surface,
      canInstall: spec.canInstall,
      canExposeInSlash: spec.canExposeInSlash,
    }))).toEqual([
      { id: 'token-counter', surface: 'status_bar', canInstall: true, canExposeInSlash: false },
      { id: 'catppuccin-theme', surface: 'theme', canInstall: true, canExposeInSlash: false },
      { id: 'openai-codex-auth', surface: 'provider', canInstall: true, canExposeInSlash: false },
      { id: 'cursor-auth', surface: 'provider', canInstall: true, canExposeInSlash: false },
    ]);

    expect(adaptAlmaPluginToCodeAgentSpec({
      id: 'slash-tools',
      name: 'Slash Tools',
      kind: 'command',
    })).toMatchObject({
      surface: 'slash_command',
      installability: 'managed_command_asset',
      canInstall: true,
      canExposeInSlash: true,
      requiredRuntimeCapabilities: ['marketplace-plugin-assets', 'command-manifest', 'plugin-permissions:command'],
    });
  });

  it('summarizes plugin trust fields and treats missing declarations as unknown risk', () => {
    expect(getPluginTrustSummary(catalog[0]!)).toContain('1 skills');
    expect(getPluginTrustSummary(catalog[0]!)).toContain('1 commands');
    expect(getPluginTrustSummary(catalog[1]!)).toContain(`${pluginsText.trustSummary.undeclared} ${pluginsText.trustSummary.permissionsUnit}`);
    expect(getPluginTrustSummary(catalog[1]!)).toContain(pluginsText.trustSummary.unknownRiskNotice);
  });
});
