import { describe, expect, it } from 'vitest';
import { buildBlockedCapabilityReasons } from '../../../src/renderer/utils/workbenchBlockedReasons';

describe('buildBlockedCapabilityReasons', () => {
  it('returns structured blocked reasons for selected but unavailable capabilities', () => {
    const reasons = buildBlockedCapabilityReasons({
      selectedSkillIds: ['draft-skill', 'missing-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github', 'slack'],
    }, {
      skills: [
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
          connected: false,
          detail: 'offline',
          capabilities: [],
        },
      ],
      mcpServers: [
        {
          kind: 'mcp',
          id: 'github',
          label: 'github',
          selected: false,
          status: 'error',
          enabled: true,
          transport: 'stdio',
          toolCount: 0,
          resourceCount: 0,
          error: 'auth failed',
        },
        {
          kind: 'mcp',
          id: 'slack',
          label: 'slack',
          selected: false,
          status: 'disconnected',
          enabled: false,
          transport: 'stdio',
          toolCount: 0,
          resourceCount: 0,
          error: undefined,
        },
      ],
    });

    expect(reasons.map((reason) => reason.code)).toEqual([
      'skill_not_mounted',
      'skill_missing',
      'connector_disconnected',
      'mcp_error',
      'mcp_disconnected',
    ]);
    expect(reasons[0]).toMatchObject({
      kind: 'skill',
      id: 'draft-skill',
      severity: 'warning',
    });
    expect(reasons[1]).toMatchObject({
      kind: 'skill',
      id: 'missing-skill',
      severity: 'error',
    });
  });
});
