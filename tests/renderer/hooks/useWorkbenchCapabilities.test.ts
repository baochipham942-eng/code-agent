import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchHistory,
  buildReferencedWorkbenchSkills,
  buildWorkbenchCapabilities,
  buildWorkbenchReferences,
  extractWorkbenchInvocationSummary,
} from '../../../src/renderer/hooks/useWorkbenchCapabilities';

describe('buildWorkbenchCapabilities', () => {
  it('merges mounted, connected, and selected workbench resources into one capability model', () => {
    const capabilities = buildWorkbenchCapabilities({
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
        {
          name: 'plan-skill',
          description: 'Plan implementation steps',
          promptContent: '',
          basePath: '/Users/linchen/.claude/skills/plan-skill',
          allowedTools: [],
          disableModelInvocation: false,
          userInvocable: true,
          executionContext: 'inline',
          source: 'user',
        },
      ],
      selectedSkillIds: ['review-skill', 'draft-skill'],
      connectorStatuses: [
        {
          id: 'mail',
          label: 'Mail',
          connected: true,
          detail: 'ready',
          capabilities: ['list_messages'],
        },
      ],
      selectedConnectorIds: ['mail', 'calendar'],
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
      ],
      selectedMcpServerIds: ['github', 'slack'],
    });

    expect(capabilities.skills).toEqual([
      {
        kind: 'skill',
        id: 'review-skill',
        label: 'review-skill',
        selected: true,
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
        selected: true,
        mounted: false,
        installState: 'available',
        description: 'Draft release notes',
        source: 'library',
        libraryId: 'community',
      },
      {
        kind: 'skill',
        id: 'plan-skill',
        label: 'plan-skill',
        selected: false,
        mounted: false,
        installState: 'available',
        description: 'Plan implementation steps',
        source: 'user',
        libraryId: 'user',
      },
    ]);

    expect(capabilities.connectors).toEqual([
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        selected: true,
        connected: true,
        detail: 'ready',
        capabilities: ['list_messages'],
      },
      {
        kind: 'connector',
        id: 'calendar',
        label: 'calendar',
        selected: true,
        connected: false,
        detail: undefined,
        capabilities: [],
      },
    ]);

    expect(capabilities.mcpServers).toEqual([
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        selected: true,
        status: 'connected',
        enabled: true,
        transport: 'stdio',
        toolCount: 12,
        resourceCount: 3,
        error: undefined,
      },
      {
        kind: 'mcp',
        id: 'slack',
        label: 'slack',
        selected: true,
        status: 'disconnected',
        enabled: false,
        transport: 'stdio',
        toolCount: 0,
        resourceCount: 0,
        error: undefined,
      },
    ]);
  });

  it('builds referenced skills from mounted capabilities and invoked skill names', () => {
    const references = buildReferencedWorkbenchSkills([
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
    ], ['draft-skill', 'missing-skill']);

    expect(references).toEqual([
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
        invoked: false,
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
        invoked: true,
      },
      {
        kind: 'skill',
        id: 'missing-skill',
        label: 'missing-skill',
        selected: false,
        mounted: false,
        installState: 'missing',
        description: undefined,
        source: undefined,
        libraryId: undefined,
        invoked: true,
      },
    ]);
  });

  it('extracts skill, connector, and MCP invocations from tool calls', () => {
    const invocationSummary = extractWorkbenchInvocationSummary([
      {
        toolCalls: [
          {
            id: '1',
            name: 'skill',
            arguments: { command: 'review-skill' },
          },
          {
            id: '2',
            name: 'mail_send',
            arguments: {},
          },
          {
            id: '3',
            name: 'mcp__github__search_code',
            arguments: {},
          },
          {
            id: '4',
            name: 'Skill',
            arguments: { skill: 'draft-skill' },
          },
        ],
      },
    ]);

    expect(invocationSummary).toEqual({
      skillIds: ['review-skill', 'draft-skill'],
      connectorIds: ['mail'],
      mcpServerIds: ['github'],
    });
  });

  it('builds unified workbench references across skill, connector, and MCP capabilities', () => {
    const references = buildWorkbenchReferences({
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
      ],
      connectors: [
        {
          kind: 'connector',
          id: 'mail',
          label: 'Mail',
          selected: false,
          connected: true,
          detail: 'ready',
          capabilities: ['list_messages'],
        },
      ],
      mcpServers: [
        {
          kind: 'mcp',
          id: 'github',
          label: 'github',
          selected: false,
          status: 'connected',
          enabled: true,
          transport: 'stdio',
          toolCount: 12,
          resourceCount: 3,
          error: undefined,
        },
      ],
      invocationSummary: {
        skillIds: ['review-skill'],
        connectorIds: ['mail', 'calendar'],
        mcpServerIds: ['github', 'filesystem'],
      },
    });

    expect(references).toEqual([
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
        invoked: true,
      },
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        selected: false,
        connected: true,
        detail: 'ready',
        capabilities: ['list_messages'],
        invoked: true,
      },
      {
        kind: 'connector',
        id: 'calendar',
        label: 'calendar',
        selected: false,
        connected: false,
        detail: undefined,
        capabilities: [],
        invoked: true,
      },
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        selected: false,
        status: 'connected',
        enabled: true,
        transport: 'stdio',
        toolCount: 12,
        resourceCount: 3,
        error: undefined,
        invoked: true,
      },
      {
        kind: 'mcp',
        id: 'filesystem',
        label: 'filesystem',
        selected: false,
        status: 'disconnected',
        enabled: false,
        transport: 'stdio',
        toolCount: 0,
        resourceCount: 0,
        error: undefined,
        invoked: true,
      },
    ]);
  });

  it('builds unified workbench history grouped by capability instead of raw tool names', () => {
    const history = buildWorkbenchHistory({
      messages: [
        {
          timestamp: 100,
          toolCalls: [
            {
              id: '1',
              name: 'mail_send',
              arguments: {},
            },
            {
              id: '2',
              name: 'mail_draft',
              arguments: {},
            },
            {
              id: '3',
              name: 'mcp__github__search_code',
              arguments: {},
            },
            {
              id: '4',
              name: 'skill',
              arguments: { command: 'review-skill' },
            },
          ],
        },
        {
          timestamp: 200,
          toolCalls: [
            {
              id: '5',
              name: 'mail_send',
              arguments: {},
            },
            {
              id: '6',
              name: 'mcp__github__get_pull_request',
              arguments: {},
            },
          ],
        },
      ],
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
      ],
      connectors: [
        {
          kind: 'connector',
          id: 'mail',
          label: 'Mail',
          selected: false,
          connected: true,
          detail: 'ready',
          capabilities: ['list_messages'],
        },
      ],
      mcpServers: [
        {
          kind: 'mcp',
          id: 'github',
          label: 'github',
          selected: false,
          status: 'connected',
          enabled: true,
          transport: 'stdio',
          toolCount: 12,
          resourceCount: 3,
          error: undefined,
        },
      ],
    });

    expect(history).toEqual([
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        count: 3,
        lastUsed: 200,
        topActions: [
          { label: 'send', count: 2 },
          { label: 'draft', count: 1 },
        ],
      },
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        count: 2,
        lastUsed: 200,
        topActions: [
          { label: 'get_pull_request', count: 1 },
          { label: 'search_code', count: 1 },
        ],
      },
      {
        kind: 'skill',
        id: 'review-skill',
        label: 'review-skill',
        count: 1,
        lastUsed: 100,
        topActions: [],
      },
    ]);
  });
});
