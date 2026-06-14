import { describe, expect, it } from 'vitest';
import {
  getAlmaMcpRecommendationPolicy,
  getAlmaPluginRecommendationPolicy,
  getAlmaSkillRecommendationPolicy,
} from '../../../src/shared/constants/almaRecommendationPolicy';
import { RECOMMENDED_MCP_SERVERS } from '../../../src/shared/constants/mcpCatalog';
import { ALMA_BUNDLED_SKILL_MAPPINGS } from '../../../src/shared/constants/skillCatalog';
import { ALMA_FEATURED_PLUGIN_REGISTRY } from '../../../src/shared/constants/almaPluginRegistry';

describe('almaRecommendationPolicy', () => {
  it('keeps Alma MCP featured separate from default enablement', () => {
    const context7 = RECOMMENDED_MCP_SERVERS.find((server) => server.id === 'context7')!;
    const fetch = RECOMMENDED_MCP_SERVERS.find((server) => server.id === 'fetch')!;
    const taskMaster = RECOMMENDED_MCP_SERVERS.find((server) => server.id === 'task_master')!;

    expect(getAlmaMcpRecommendationPolicy(context7)).toMatchObject({
      kind: 'mcp',
      tier: 'default_visible',
      action: 'show_in_default_surface',
    });
    expect(getAlmaMcpRecommendationPolicy(fetch)).toMatchObject({
      kind: 'mcp',
      tier: 'conditional',
      action: 'show_when_relevant',
    });
    expect(getAlmaMcpRecommendationPolicy(taskMaster)).toMatchObject({
      kind: 'mcp',
      tier: 'not_default',
      action: 'reference_only',
    });
  });

  it('maps covered Alma skills to reference-only policy instead of install recommendation', () => {
    const browser = ALMA_BUNDLED_SKILL_MAPPINGS.find((skill) => skill.name === 'browser')!;
    const computerUse = ALMA_BUNDLED_SKILL_MAPPINGS.find((skill) => skill.name === 'computer-use')!;
    const reactions = ALMA_BUNDLED_SKILL_MAPPINGS.find((skill) => skill.name === 'reactions')!;

    expect(getAlmaSkillRecommendationPolicy(browser)).toMatchObject({
      tier: 'not_default',
      action: 'reference_only',
      label: '已覆盖',
      coveredBy: 'Browser / Playwright / Live Preview',
    });
    expect(getAlmaSkillRecommendationPolicy(computerUse)).toMatchObject({
      tier: 'default_visible',
      action: 'show_in_default_surface',
    });
    expect(getAlmaSkillRecommendationPolicy(reactions)).toMatchObject({
      tier: 'unsupported',
      action: 'block_install',
    });
  });

  it('allows provider and theme managed asset installs without implying runtime authorization', () => {
    const tokenCounter = ALMA_FEATURED_PLUGIN_REGISTRY.find((plugin) => plugin.id === 'token-counter')!;
    const catppuccin = ALMA_FEATURED_PLUGIN_REGISTRY.find((plugin) => plugin.id === 'catppuccin-theme')!;
    const codexAuth = ALMA_FEATURED_PLUGIN_REGISTRY.find((plugin) => plugin.id === 'openai-codex-auth')!;

    expect(getAlmaPluginRecommendationPolicy(tokenCounter)).toMatchObject({
      tier: 'default_visible',
      action: 'show_in_default_surface',
    });
    expect(getAlmaPluginRecommendationPolicy(catppuccin)).toMatchObject({
      tier: 'conditional',
      action: 'show_when_relevant',
    });
    expect(getAlmaPluginRecommendationPolicy(codexAuth)).toMatchObject({
      tier: 'conditional',
      action: 'show_when_relevant',
    });
    expect(getAlmaPluginRecommendationPolicy(codexAuth).riskNote).toContain('安装不等于 OAuth 授权');
  });
});
