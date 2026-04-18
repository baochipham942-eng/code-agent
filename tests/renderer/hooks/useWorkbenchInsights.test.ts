import { describe, expect, it } from 'vitest';
import { buildWorkbenchInsights } from '../../../src/renderer/hooks/useWorkbenchInsights';

describe('buildWorkbenchInsights', () => {
  it('assembles capabilities, references, and history into one unified insight model', () => {
    const insights = buildWorkbenchInsights({
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
              name: 'mcp__github__search_code',
              arguments: {},
            },
            {
              id: '3',
              name: 'skill',
              arguments: { command: 'review-skill' },
            },
          ],
        },
      ],
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
          },
        ],
      },
    });

    expect(insights.invocationSummary).toEqual({
      skillIds: ['review-skill'],
      connectorIds: ['mail'],
      mcpServerIds: ['github'],
    });
    expect(insights.references).toHaveLength(3);
    expect(insights.history).toHaveLength(3);
    expect(insights.connectorHistory).toEqual([
      {
        kind: 'connector',
        id: 'mail',
        label: 'Mail',
        count: 1,
        lastUsed: 100,
        topActions: [{ label: 'send', count: 1 }],
      },
    ]);
    expect(insights.mcpHistory).toEqual([
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        count: 1,
        lastUsed: 100,
        topActions: [{ label: 'search_code', count: 1 }],
      },
    ]);
    expect(insights.skillHistory).toEqual([
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
