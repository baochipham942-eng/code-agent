import { describe, expect, it } from 'vitest';
import {
  createWorkbenchRecipeMergedContext,
  createWorkbenchRecipeFromPresets,
  createWorkbenchPresetContextFromSession,
  createWorkbenchPresetFromSession,
  hasWorkbenchPresetContext,
  normalizeWorkbenchRecipe,
  type WorkbenchPreset,
} from '../../../src/shared/contract/workbenchPreset';

describe('workbenchPreset contract', () => {
  it('creates a normalized preset context from session provenance', () => {
    const context = createWorkbenchPresetContextFromSession({
      id: 'session-1',
      title: 'Browser review',
      workingDirectory: '/tmp/fallback',
      workbenchSnapshot: {
        summary: 'snapshot',
        labels: ['Browser'],
        recentToolNames: ['browser_action'],
        routingMode: 'parallel',
        skillIds: ['snapshot-skill'],
        connectorIds: ['snapshot-connector'],
        mcpServerIds: ['snapshot-mcp'],
      },
      workbenchProvenance: {
        capturedAt: 100,
        workingDirectory: '/tmp/reused',
        routingMode: 'direct',
        targetAgentIds: ['agent-1', 'agent-1'],
        selectedSkillIds: ['review-skill', 'review-skill'],
        selectedConnectorIds: ['mail', 'mail'],
        selectedMcpServerIds: ['github', 'github'],
        executionIntent: {
          browserSessionMode: 'managed',
          preferBrowserSession: true,
          allowBrowserAutomation: true,
        },
      },
    });

    expect(context).toMatchObject({
      workingDirectory: '/tmp/reused',
      routingMode: 'direct',
      targetAgentIds: ['agent-1'],
      browserSessionMode: 'managed',
      selectedSkillIds: ['review-skill'],
      selectedConnectorIds: ['mail'],
      selectedMcpServerIds: ['github'],
    });
  });

  it('downgrades direct routing when the saved context has no targets', () => {
    const context = createWorkbenchPresetContextFromSession({
      workingDirectory: null,
      workbenchSnapshot: {
        summary: 'direct without targets',
        labels: ['Direct'],
        recentToolNames: [],
        routingMode: 'direct',
        skillIds: ['review-skill'],
      },
    });

    expect(context.routingMode).toBe('auto');
    expect(context.targetAgentIds).toEqual([]);
    expect(hasWorkbenchPresetContext(context)).toBe(true);
  });

  it('returns null when creating a preset from an empty session source', () => {
    expect(createWorkbenchPresetFromSession({
      id: 'session-empty',
      title: 'Empty',
      workingDirectory: '   ',
    })).toBeNull();
  });

  it('creates a normalized recipe from a set of presets', () => {
    const recipe = createWorkbenchRecipeFromPresets([
      {
        version: 1,
        id: 'preset-a',
        name: ' Browser ',
        createdAt: 1,
        updatedAt: 1,
        source: { kind: 'manual' },
        context: {
          workingDirectory: ' /repo/code-agent ',
          routingMode: 'direct',
          targetAgentIds: ['agent-1', 'agent-1'],
          browserSessionMode: 'managed',
          selectedSkillIds: ['skill-a', 'skill-a'],
          selectedConnectorIds: ['mail', 'mail'],
          selectedMcpServerIds: ['github', 'github'],
        },
      } satisfies WorkbenchPreset,
      {
        version: 1,
        id: 'preset-b',
        name: 'Connectors',
        createdAt: 2,
        updatedAt: 2,
        source: { kind: 'manual' },
        context: {
          workingDirectory: null,
          routingMode: 'auto',
          targetAgentIds: ['agent-unused'],
          browserSessionMode: 'none',
          selectedSkillIds: [],
          selectedConnectorIds: ['calendar'],
          selectedMcpServerIds: [],
        },
      } satisfies WorkbenchPreset,
    ], {
      id: 'recipe-1',
      name: ' Review flow ',
      description: ' two steps ',
      now: 100,
    });

    expect(recipe).toMatchObject({
      id: 'recipe-1',
      name: 'Review flow',
      description: 'two steps',
      createdAt: 100,
      updatedAt: 100,
      steps: [
        {
          id: 'step-1-preset-a',
          name: 'Browser',
          presetId: 'preset-a',
          context: {
            workingDirectory: '/repo/code-agent',
            routingMode: 'direct',
            targetAgentIds: ['agent-1'],
            selectedSkillIds: ['skill-a'],
            selectedConnectorIds: ['mail'],
            selectedMcpServerIds: ['github'],
          },
        },
        {
          id: 'step-2-preset-b',
          name: 'Connectors',
          presetId: 'preset-b',
          context: {
            routingMode: 'auto',
            targetAgentIds: [],
            selectedConnectorIds: ['calendar'],
          },
        },
      ],
    });
  });

  it('normalizes recipe steps and drops empty steps', () => {
    expect(normalizeWorkbenchRecipe({
      version: 1,
      id: ' recipe-2 ',
      name: ' ',
      createdAt: 1,
      updatedAt: 0,
      steps: [
        {
          id: ' ',
          name: ' ',
          notes: '  ',
        },
        {
          id: 'custom-step',
          name: ' Managed browser ',
          presetId: ' preset-a ',
          notes: ' launch browser ',
        },
      ],
    })).toMatchObject({
      id: 'recipe-2',
      name: 'Workbench recipe',
      updatedAt: 1,
      steps: [
        {
          id: 'custom-step',
          name: 'Managed browser',
          presetId: 'preset-a',
          notes: 'launch browser',
        },
      ],
    });
  });

  it('merges recipe step context in order for product application', () => {
    const context = createWorkbenchRecipeMergedContext({
      version: 1,
      id: 'recipe-merge',
      name: 'Merge',
      createdAt: 1,
      updatedAt: 1,
      steps: [
        {
          id: 'step-1',
          name: 'Browser',
          context: {
            workingDirectory: '/repo/first',
            routingMode: 'direct',
            targetAgentIds: ['agent-1', 'agent-1'],
            browserSessionMode: 'managed',
            selectedSkillIds: ['skill-a', 'skill-a'],
            selectedConnectorIds: ['mail'],
            selectedMcpServerIds: [],
            executionIntent: {
              browserSessionMode: 'managed',
              preferBrowserSession: true,
              allowBrowserAutomation: true,
            },
          },
        },
        {
          id: 'step-2',
          name: 'Connectors',
          context: {
            workingDirectory: ' /repo/second ',
            routingMode: 'auto',
            targetAgentIds: [],
            browserSessionMode: 'none',
            selectedSkillIds: ['skill-a'],
            selectedConnectorIds: ['calendar', 'mail'],
            selectedMcpServerIds: ['github', 'github'],
          },
        },
        {
          id: 'step-3',
          name: 'Parallel desktop',
          context: {
            workingDirectory: null,
            routingMode: 'parallel',
            targetAgentIds: [],
            browserSessionMode: 'desktop',
            selectedSkillIds: [],
            selectedConnectorIds: ['reminders'],
            selectedMcpServerIds: [],
            executionIntent: {
              browserSessionMode: 'desktop',
              preferBrowserSession: true,
              preferDesktopContext: true,
            },
          },
        },
      ],
    });

    expect(context).toMatchObject({
      workingDirectory: '/repo/second',
      routingMode: 'parallel',
      targetAgentIds: [],
      browserSessionMode: 'desktop',
      selectedSkillIds: ['skill-a'],
      selectedConnectorIds: ['mail', 'calendar', 'reminders'],
      selectedMcpServerIds: ['github'],
      executionIntent: {
        browserSessionMode: 'desktop',
        preferBrowserSession: true,
        preferDesktopContext: true,
      },
    });
  });

  it('returns null when no preset has reusable workbench context', () => {
    expect(createWorkbenchRecipeFromPresets([
      {
        version: 1,
        id: 'empty',
        name: 'Empty',
        createdAt: 1,
        updatedAt: 1,
        source: { kind: 'manual' },
        context: {
          workingDirectory: null,
          routingMode: 'auto',
          targetAgentIds: [],
          browserSessionMode: 'none',
          selectedSkillIds: [],
          selectedConnectorIds: [],
          selectedMcpServerIds: [],
        },
      },
    ], {
      now: 100,
    })).toBeNull();
  });
});
