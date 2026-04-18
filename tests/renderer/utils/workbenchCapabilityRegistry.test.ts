import { describe, expect, it } from 'vitest';
import { buildWorkbenchCapabilityRegistry } from '../../../src/renderer/utils/workbenchCapabilityRegistry';

describe('buildWorkbenchCapabilityRegistry', () => {
  it('maps raw skill, connector, and MCP state into one lifecycle registry', () => {
    const registry = buildWorkbenchCapabilityRegistry({
      mountedSkills: [
        {
          skillName: 'review-skill',
          libraryId: 'core',
          mountedAt: 1,
          source: 'manual',
        },
      ],
      availableSkills: [
        {
          name: 'review-skill',
          description: 'Review code changes',
          promptContent: '',
          basePath: '/repo/libraries/core/skills/review-skill',
          allowedTools: [],
          disableModelInvocation: false,
          userInvocable: true,
          executionContext: 'inline',
          source: 'library',
        },
        {
          name: 'draft-skill',
          description: 'Draft release notes',
          promptContent: '',
          basePath: '/repo/libraries/community/skills/draft-skill',
          allowedTools: [],
          disableModelInvocation: false,
          userInvocable: true,
          executionContext: 'inline',
          source: 'library',
        },
      ],
      selectedSkillIds: ['draft-skill', 'missing-skill'],
      connectorStatuses: [
        {
          id: 'mail',
          label: 'Mail',
          connected: true,
          detail: 'ready',
          capabilities: ['list_messages'],
        },
        {
          id: 'calendar',
          label: 'Calendar',
          connected: false,
          detail: 'offline',
          capabilities: ['list_events'],
        },
      ],
      selectedConnectorIds: ['calendar'],
      mcpServerStates: [
        {
          config: {
            name: 'github',
            type: 'stdio',
            enabled: true,
          },
          status: 'connected',
          toolCount: 12,
          resourceCount: 3,
        },
        {
          config: {
            name: 'slack',
            type: 'stdio',
            enabled: true,
          },
          status: 'disconnected',
          toolCount: 0,
          resourceCount: 0,
        },
        {
          config: {
            name: 'docs',
            type: 'sse',
            enabled: true,
          },
          status: 'connecting',
          toolCount: 0,
          resourceCount: 0,
        },
      ],
      selectedMcpServerIds: ['slack'],
    });

    expect(registry.skills.find((skill) => skill.id === 'review-skill')).toMatchObject({
      available: true,
      blocked: false,
      health: 'healthy',
      visibleInWorkbench: true,
      lifecycle: {
        installState: 'installed',
        mountState: 'mounted',
        connectionState: 'not_applicable',
      },
    });

    expect(registry.skills.find((skill) => skill.id === 'draft-skill')).toMatchObject({
      selected: true,
      available: false,
      blocked: true,
      health: 'inactive',
      visibleInWorkbench: true,
      blockedReason: {
        code: 'skill_not_mounted',
        severity: 'warning',
      },
    });

    expect(registry.skills.find((skill) => skill.id === 'missing-skill')).toMatchObject({
      selected: true,
      available: false,
      blocked: true,
      health: 'error',
      blockedReason: {
        code: 'skill_missing',
        severity: 'error',
      },
    });

    expect(registry.connectors.find((connector) => connector.id === 'calendar')).toMatchObject({
      selected: true,
      available: false,
      blocked: true,
      health: 'inactive',
      visibleInWorkbench: true,
      blockedReason: {
        code: 'connector_disconnected',
        severity: 'warning',
      },
    });

    expect(registry.mcpServers.map((server) => server.id)).toEqual(['github', 'slack', 'docs']);
    expect(registry.mcpServers.find((server) => server.id === 'slack')).toMatchObject({
      selected: true,
      available: false,
      blocked: true,
      health: 'inactive',
      blockedReason: {
        code: 'mcp_disconnected',
        severity: 'warning',
      },
    });
    expect(registry.mcpServers.find((server) => server.id === 'docs')).toMatchObject({
      selected: false,
      available: false,
      blocked: false,
      health: 'degraded',
      lifecycle: {
        installState: 'not_applicable',
        mountState: 'not_applicable',
        connectionState: 'connecting',
      },
    });
  });
});
