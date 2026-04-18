import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import {
  buildCurrentTurnBlockedCapabilities,
  buildCurrentTurnSelectedCapabilities,
  extractCurrentTurnCapabilityScope,
} from '../../../src/renderer/hooks/useCurrentTurnCapabilityScope';

describe('extractCurrentTurnCapabilityScope', () => {
  it('uses the latest turn instead of activeTurnIndex when a new workbench turn is appended', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          endTime: 150,
          nodes: [
            {
              id: 'scope-old',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'timeline-old',
                kind: 'capability_scope',
                timestamp: 120,
                tone: 'success',
                capabilityScope: {
                  selected: [],
                  allowed: [],
                  blocked: [],
                  invoked: [
                    {
                      kind: 'connector',
                      id: 'mail',
                      label: 'Mail',
                      count: 1,
                      topActions: [{ label: 'send', count: 1 }],
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          turnNumber: 2,
          turnId: 'turn-2',
          status: 'completed',
          startTime: 200,
          endTime: 220,
          nodes: [
            {
              id: 'scope-new',
              type: 'turn_timeline',
              content: '',
              timestamp: 205,
              turnTimeline: {
                id: 'timeline-new',
                kind: 'capability_scope',
                timestamp: 205,
                tone: 'warning',
                capabilityScope: {
                  selected: [
                    {
                      kind: 'skill',
                      id: 'draft-skill',
                      label: 'draft-skill',
                    },
                  ],
                  allowed: [],
                  blocked: [
                    {
                      kind: 'skill',
                      id: 'draft-skill',
                      label: 'draft-skill',
                      code: 'skill_not_mounted',
                      detail: 'Skill draft-skill 已安装但未挂载，本轮不会调用。',
                      hint: '去 TaskPanel/Skills 把它挂到当前会话。',
                      severity: 'warning',
                    },
                  ],
                  invoked: [],
                },
              },
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnCapabilityScope(projection)).toMatchObject({
      turnId: 'turn-2',
      turnNumber: 2,
      tone: 'warning',
      scope: {
        selected: [
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
          },
        ],
      },
    });
  });

  it('returns null when the latest turn has no capability scope node', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'completed',
          startTime: 100,
          endTime: 150,
          nodes: [
            {
              id: 'scope-old',
              type: 'turn_timeline',
              content: '',
              timestamp: 120,
              turnTimeline: {
                id: 'timeline-old',
                kind: 'capability_scope',
                timestamp: 120,
                tone: 'success',
                capabilityScope: {
                  selected: [],
                  allowed: [],
                  blocked: [],
                  invoked: [],
                },
              },
            },
          ],
        },
        {
          turnNumber: 2,
          turnId: 'turn-2',
          status: 'completed',
          startTime: 200,
          endTime: 220,
          nodes: [
            {
              id: 'assistant-2',
              type: 'assistant_text',
              content: '这一轮没有 capability scope',
              timestamp: 210,
            },
          ],
        },
      ],
    };

    expect(extractCurrentTurnCapabilityScope(projection)).toBeNull();
  });

  it('derives blocked capability action sources from the latest turn snapshot and shared registry builders', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'completed',
          startTime: 100,
          endTime: 160,
          nodes: [
            {
              id: 'snapshot-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 100,
              turnTimeline: {
                id: 'timeline-snapshot-1',
                kind: 'workbench_snapshot',
                timestamp: 100,
                tone: 'info',
                snapshot: {
                  selectedSkillIds: ['draft-skill'],
                  selectedConnectorIds: ['mail'],
                  selectedMcpServerIds: ['github'],
                },
              },
            },
            {
              id: 'scope-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 100,
              turnTimeline: {
                id: 'timeline-scope-1',
                kind: 'capability_scope',
                timestamp: 100,
                tone: 'warning',
                capabilityScope: {
                  selected: [],
                  allowed: [],
                  blocked: [],
                  invoked: [],
                },
              },
            },
          ],
        },
      ],
    };

    const blockedCapabilities = buildCurrentTurnBlockedCapabilities({
      projection,
      capabilities: {
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
            capabilities: ['send'],
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
            toolCount: 5,
            resourceCount: 1,
            error: 'auth failed',
          },
        ],
      },
    });

    expect(blockedCapabilities.map((capability) => `${capability.kind}:${capability.id}:${capability.blockedReason?.code}`)).toEqual([
      'skill:draft-skill:skill_not_mounted',
      'connector:mail:connector_disconnected',
      'mcp:github:mcp_error',
    ]);
  });

  it('keeps current selected capability state so historical blocked rows can show repaired status', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'completed',
          startTime: 100,
          endTime: 160,
          nodes: [
            {
              id: 'snapshot-1',
              type: 'turn_timeline',
              content: '',
              timestamp: 100,
              turnTimeline: {
                id: 'timeline-snapshot-1',
                kind: 'workbench_snapshot',
                timestamp: 100,
                tone: 'info',
                snapshot: {
                  selectedSkillIds: ['draft-skill'],
                },
              },
            },
          ],
        },
      ],
    };

    const selectedCapabilities = buildCurrentTurnSelectedCapabilities({
      projection,
      capabilities: {
        skills: [
          {
            kind: 'skill',
            id: 'draft-skill',
            label: 'draft-skill',
            selected: false,
            mounted: true,
            installState: 'mounted',
            description: 'Draft release notes',
            source: 'library',
            libraryId: 'community',
          },
        ],
        connectors: [],
        mcpServers: [],
      },
    });

    expect(selectedCapabilities).toMatchObject([
      {
        kind: 'skill',
        id: 'draft-skill',
        selected: true,
        available: true,
        blocked: false,
      },
    ]);
  });
});
