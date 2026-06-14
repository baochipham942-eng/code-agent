import { describe, expect, it } from 'vitest';
import {
  ALMA_REVIEWED_MCP_REGISTRY_AUDIT,
  ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT,
  buildAlmaMcpRegistryAudit,
  buildAlmaPluginRegistryAudit,
  buildAlmaRegistryDriftReport,
} from '../../../src/shared/constants/almaRegistryAudit';

describe('almaRegistryAudit', () => {
  it('keeps reviewed MCP and plugin registry snapshots stable', () => {
    expect(ALMA_REVIEWED_MCP_REGISTRY_AUDIT).toMatchObject({
      kind: 'mcp',
      version: '1.0.0',
      totalItems: 37,
      featuredIds: ['context7', 'fetch', 'firecrawl', 'github', 'playwright', 'task_master'],
      defaultFlagMatches: [],
    });
    expect(ALMA_REVIEWED_MCP_REGISTRY_AUDIT.snapshotFingerprint).toMatch(/^[0-9a-f]{8}$/);

    expect(ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT).toMatchObject({
      kind: 'plugin',
      version: '1.0.0',
      totalItems: 8,
      featuredIds: ['token-counter', 'catppuccin-theme', 'openai-codex-auth', 'cursor-auth'],
      defaultFlagMatches: [],
    });
    expect(ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT.snapshotFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('audits live-shaped MCP payloads and reports drift from the reviewed snapshot', () => {
    const current = buildAlmaMcpRegistryAudit({
      version: '1.1.0',
      servers: [
        { id: 'context7', name: 'Context7', featured: true },
        { id: 'github', name: 'GitHub', featured: true, builtin: true } as never,
        { id: 'new-featured', name: 'New Featured', featured: true },
      ],
    });
    const drift = buildAlmaRegistryDriftReport(ALMA_REVIEWED_MCP_REGISTRY_AUDIT, current);

    expect(current).toMatchObject({
      kind: 'mcp',
      version: '1.1.0',
      totalItems: 3,
      featuredIds: ['context7', 'github', 'new-featured'],
      defaultFlagMatches: ['github'],
    });
    expect(drift).toMatchObject({
      status: 'changed',
      changedFields: ['version', 'totalItems', 'featuredIds', 'defaultFlagMatches'],
      addedFeaturedIds: ['new-featured'],
      defaultFlagMatches: ['github'],
    });
    expect(drift.removedFeaturedIds).toEqual(['fetch', 'firecrawl', 'playwright', 'task_master']);
  });

  it('audits live-shaped plugin payloads without treating featured as default', () => {
    const current = buildAlmaPluginRegistryAudit({
      version: '1.0.0',
      plugins: [
        { id: 'token-counter', name: 'Token Counter', type: 'ui', featured: true },
        { id: 'slash-tools', name: 'Slash Tools', type: 'command', featured: true },
        { id: 'plain-theme', name: 'Plain Theme', type: 'theme', featured: false },
      ],
    });
    const drift = buildAlmaRegistryDriftReport(ALMA_REVIEWED_PLUGIN_REGISTRY_AUDIT, current);

    expect(current.defaultFlagMatches).toEqual([]);
    expect(drift.status).toBe('changed');
    expect(drift.addedFeaturedIds).toEqual(['slash-tools']);
    expect(drift.removedFeaturedIds).toEqual(['catppuccin-theme', 'openai-codex-auth', 'cursor-auth']);
  });
});
