import { describe, expect, it } from 'vitest';
import {
  findWorkbenchCapabilityHistoryItem,
  resolveWorkbenchCapabilityFromSources,
} from '../../../src/renderer/utils/workbenchCapabilitySheet';

describe('workbenchCapabilitySheet helpers', () => {
  it('resolves detail capability from current registry items first', () => {
    const capability = resolveWorkbenchCapabilityFromSources({
      target: {
        kind: 'skill',
        id: 'review-skill',
      },
      primaryItems: [
        {
          kind: 'skill',
          key: 'skill:review-skill',
          id: 'review-skill',
          label: 'review-skill',
          selected: true,
          mounted: true,
          installState: 'mounted',
          description: 'Review code changes',
          source: 'library',
          libraryId: 'core',
          available: true,
          blocked: false,
          visibleInWorkbench: true,
          health: 'healthy',
          lifecycle: {
            installState: 'installed',
            mountState: 'mounted',
            connectionState: 'not_applicable',
          },
        },
      ],
    });

    expect(capability).toMatchObject({
      kind: 'skill',
      id: 'review-skill',
      available: true,
      lifecycle: {
        mountState: 'mounted',
      },
    });
  });

  it('falls back to reference adapter when the registry item is not currently visible', () => {
    const capability = resolveWorkbenchCapabilityFromSources({
      target: {
        kind: 'connector',
        id: 'calendar',
      },
      references: [
        {
          kind: 'connector',
          id: 'calendar',
          label: 'Calendar',
          selected: false,
          connected: false,
          detail: 'offline',
          capabilities: ['list_events'],
          invoked: true,
        },
      ],
    });

    expect(capability).toMatchObject({
      kind: 'connector',
      id: 'calendar',
      available: false,
      lifecycle: {
        connectionState: 'disconnected',
      },
    });
  });

  it('matches recent history by capability kind and id', () => {
    const historyItem = findWorkbenchCapabilityHistoryItem([
      {
        kind: 'mcp',
        id: 'github',
        label: 'github',
        count: 2,
        lastUsed: 300,
        topActions: [{ label: 'search_code', count: 2 }],
      },
    ], {
      kind: 'mcp',
      id: 'github',
    });

    expect(historyItem).toEqual({
      kind: 'mcp',
      id: 'github',
      label: 'github',
      count: 2,
      lastUsed: 300,
      topActions: [{ label: 'search_code', count: 2 }],
    });
  });
});
