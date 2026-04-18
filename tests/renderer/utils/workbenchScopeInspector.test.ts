import { describe, expect, it } from 'vitest';
import { buildWorkbenchCapabilityScope } from '../../../src/renderer/utils/workbenchScopeInspector';

describe('buildWorkbenchCapabilityScope', () => {
  it('projects selected, allowed, blocked, and invoked capability layers from one turn', () => {
    const scope = buildWorkbenchCapabilityScope({
      snapshot: {
        selectedSkillIds: ['review-skill', 'draft-skill'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
      },
      capabilities: {
        skills: [
          {
            kind: 'skill',
            id: 'review-skill',
            label: 'review-skill',
            selected: false,
            mounted: true,
            installState: 'mounted',
            description: 'Review code changes',
            source: 'library',
            libraryId: 'core',
          },
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
            selected: false,
            mounted: false,
            installState: 'available',
            description: 'Draft release notes',
            source: 'library',
            libraryId: 'community',
          },
        ],
        connectors: [
          {
            kind: 'connector',
            id: 'mail',
            label: 'Mail',
            selected: false,
            connected: true,
            detail: 'ready',
            capabilities: ['send'],
          },
        ],
        mcpServers: [
          {
            kind: 'mcp',
            id: 'github',
            label: 'github',
            selected: false,
            status: 'disconnected',
            enabled: true,
            transport: 'stdio',
            toolCount: 8,
            resourceCount: 2,
          },
        ],
      },
      toolCalls: [
        {
          id: 'tool-1',
          name: 'mail_send',
          arguments: {},
        },
        {
          id: 'tool-2',
          name: 'skill',
          arguments: {
            command: 'review-skill',
          },
        },
        {
          id: 'tool-3',
          name: 'skill',
          arguments: {
            command: 'review-skill',
          },
        },
      ],
      timestamp: 200,
    });

    expect(scope).toBeDefined();
    expect(scope?.selected.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'skill:review-skill',
      'skill:draft-skill',
      'connector:mail',
      'mcp:github',
    ]);
    expect(scope?.allowed.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'skill:review-skill',
      'connector:mail',
    ]);
    expect(scope?.blocked.map((item) => `${item.kind}:${item.id}:${item.code}`)).toEqual([
      'skill:draft-skill:skill_not_mounted',
      'mcp:github:mcp_disconnected',
    ]);
    expect(scope?.invoked).toEqual([
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        count: 1,
        topActions: [{ label: 'send', count: 1 }],
      },
      {
        kind: 'skill',
        id: 'review-skill',
        label: 'review-skill',
        count: 2,
        topActions: [],
      },
    ]);
  });
});
