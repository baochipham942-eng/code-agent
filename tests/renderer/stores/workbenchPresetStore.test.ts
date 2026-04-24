import { beforeEach, describe, expect, it, vi } from 'vitest';

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  });
  return values;
}

async function loadStore() {
  vi.resetModules();
  return import('../../../src/renderer/stores/workbenchPresetStore');
}

describe('workbenchPresetStore', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installLocalStorage();
  });

  it('saves a named preset from a session and persists it to localStorage', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();

    const preset = useWorkbenchPresetStore.getState().savePresetFromSession({
      id: 'session-1',
      title: 'Review session',
      workingDirectory: '/repo/code-agent',
      updatedAt: 90,
      workbenchSnapshot: {
        summary: '工作区 · Browser',
        labels: ['工作区', 'Browser'],
        recentToolNames: ['browser_action'],
        routingMode: 'parallel',
        skillIds: ['review-skill'],
        connectorIds: ['mail'],
        mcpServerIds: ['github'],
      },
    }, {
      name: 'Review Browser Preset',
      now: 100,
    });

    expect(preset).toMatchObject({
      name: 'Review Browser Preset',
      createdAt: 100,
      source: {
        kind: 'session',
        sessionId: 'session-1',
        sessionTitle: 'Review session',
      },
      context: {
        workingDirectory: '/repo/code-agent',
        routingMode: 'parallel',
        selectedSkillIds: ['review-skill'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
      },
    });
    expect(useWorkbenchPresetStore.getState().presets).toHaveLength(1);

    const persisted = JSON.parse(localStorage.getItem(WORKBENCH_PRESET_STORAGE_KEY) || '{}');
    expect(persisted.presets[0].name).toBe('Review Browser Preset');
  });

  it('hydrates persisted presets and normalizes duplicate ids', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();
    localStorage.setItem(WORKBENCH_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      presets: [
        {
          version: 1,
          id: 'preset-1',
          name: 'Persisted',
          createdAt: 1,
          updatedAt: 1,
          source: { kind: 'manual' },
          context: {
            workingDirectory: '/repo',
            routingMode: 'direct',
            targetAgentIds: ['agent-1', 'agent-1'],
            browserSessionMode: 'managed',
            selectedSkillIds: ['skill-a', 'skill-a'],
            selectedConnectorIds: ['mail', 'mail'],
            selectedMcpServerIds: ['github', 'github'],
            executionIntent: {
              browserSessionMode: 'managed',
              preferBrowserSession: true,
            },
          },
        },
      ],
      recipes: [],
    }));

    useWorkbenchPresetStore.getState().hydrate();

    expect(useWorkbenchPresetStore.getState().presets[0]).toMatchObject({
      id: 'preset-1',
      context: {
        targetAgentIds: ['agent-1'],
        selectedSkillIds: ['skill-a'],
        selectedConnectorIds: ['mail'],
        selectedMcpServerIds: ['github'],
      },
    });
  });

  it('renames and deletes presets in the persisted library', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();
    const preset = useWorkbenchPresetStore.getState().savePresetFromSession({
      id: 'session-1',
      title: 'Review session',
      workingDirectory: '/repo/code-agent',
    }, {
      name: 'Original',
      now: 100,
    });

    expect(preset).toBeTruthy();
    useWorkbenchPresetStore.getState().renamePreset(preset!.id, 'Renamed', 200);

    expect(useWorkbenchPresetStore.getState().presets[0]).toMatchObject({
      name: 'Renamed',
      updatedAt: 200,
    });

    useWorkbenchPresetStore.getState().deletePreset(preset!.id);

    expect(useWorkbenchPresetStore.getState().presets).toEqual([]);
    const persisted = JSON.parse(localStorage.getItem(WORKBENCH_PRESET_STORAGE_KEY) || '{}');
    expect(persisted.presets).toEqual([]);
  });

  it('creates a recipe from presets and persists it to localStorage', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();
    const firstPreset = useWorkbenchPresetStore.getState().savePresetFromSession({
      id: 'session-1',
      title: 'Browser session',
      workingDirectory: '/repo/code-agent',
      workbenchSnapshot: {
        summary: 'Browser',
        labels: ['Browser'],
        recentToolNames: [],
        routingMode: 'parallel',
        skillIds: ['review-skill', 'review-skill'],
      },
    }, {
      id: 'preset-1',
      name: 'Browser preset',
      now: 100,
    });
    const secondPreset = useWorkbenchPresetStore.getState().savePresetFromSession({
      id: 'session-2',
      title: 'Connector session',
      workingDirectory: '/repo/code-agent',
      workbenchSnapshot: {
        summary: 'Connector',
        labels: ['Connector'],
        recentToolNames: [],
        routingMode: 'auto',
        connectorIds: ['mail', 'mail'],
      },
    }, {
      id: 'preset-2',
      name: 'Connector preset',
      now: 101,
    });

    const recipe = useWorkbenchPresetStore.getState().createRecipeFromPresets([
      firstPreset!,
      secondPreset!,
    ], {
      id: 'recipe-1',
      name: ' Daily review ',
      now: 200,
    });

    expect(recipe).toMatchObject({
      id: 'recipe-1',
      name: 'Daily review',
      createdAt: 200,
      steps: [
        {
          presetId: 'preset-1',
          context: {
            workingDirectory: '/repo/code-agent',
            routingMode: 'parallel',
            selectedSkillIds: ['review-skill'],
          },
        },
        {
          presetId: 'preset-2',
          context: {
            selectedConnectorIds: ['mail'],
          },
        },
      ],
    });
    expect(useWorkbenchPresetStore.getState().getRecipeById('recipe-1')).toBe(recipe);
    expect(useWorkbenchPresetStore.getState().listRecipes()).toEqual([recipe]);

    const persisted = JSON.parse(localStorage.getItem(WORKBENCH_PRESET_STORAGE_KEY) || '{}');
    expect(persisted.recipes[0].name).toBe('Daily review');
    expect(persisted.recipes[0].steps).toHaveLength(2);
  });

  it('upserts duplicate recipe ids and persists deletion', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();

    useWorkbenchPresetStore.getState().upsertRecipe({
      version: 1,
      id: 'recipe-1',
      name: 'Original',
      createdAt: 100,
      updatedAt: 100,
      source: { kind: 'manual' },
      steps: [
        {
          id: 'step-1',
          name: 'Step 1',
          presetId: 'preset-1',
          notes: ' first ',
        },
      ],
    });
    const replacement = useWorkbenchPresetStore.getState().upsertRecipe({
      version: 1,
      id: 'recipe-1',
      name: ' Replacement ',
      description: ' updated ',
      createdAt: 100,
      updatedAt: 300,
      source: { kind: 'manual' },
      steps: [
        {
          id: 'step-2',
          name: ' Step 2 ',
          presetId: 'preset-2',
          notes: ' second ',
        },
      ],
    });

    expect(useWorkbenchPresetStore.getState().recipes).toEqual([replacement]);
    expect(replacement).toMatchObject({
      name: 'Replacement',
      description: 'updated',
      steps: [
        {
          id: 'step-2',
          name: 'Step 2',
          presetId: 'preset-2',
          notes: 'second',
        },
      ],
    });

    useWorkbenchPresetStore.getState().deleteRecipe('recipe-1');

    expect(useWorkbenchPresetStore.getState().recipes).toEqual([]);
    const persisted = JSON.parse(localStorage.getItem(WORKBENCH_PRESET_STORAGE_KEY) || '{}');
    expect(persisted.recipes).toEqual([]);
  });

  it('hydrates persisted recipes through recipe normalization', async () => {
    const { WORKBENCH_PRESET_STORAGE_KEY, useWorkbenchPresetStore } = await loadStore();
    localStorage.setItem(WORKBENCH_PRESET_STORAGE_KEY, JSON.stringify({
      version: 1,
      presets: [],
      recipes: [
        {
          version: 1,
          id: ' recipe-1 ',
          name: ' Persisted recipe ',
          description: ' saved ',
          createdAt: 1,
          updatedAt: 2,
          source: { kind: 'manual' },
          steps: [
            {
              id: ' ',
              name: ' Persisted step ',
              presetId: ' preset-1 ',
              notes: ' use this ',
            },
          ],
        },
      ],
    }));

    useWorkbenchPresetStore.getState().hydrate();

    expect(useWorkbenchPresetStore.getState().recipes[0]).toMatchObject({
      id: 'recipe-1',
      name: 'Persisted recipe',
      description: 'saved',
      steps: [
        {
          id: 'recipe-1-step-1',
          name: 'Persisted step',
          presetId: 'preset-1',
          notes: 'use this',
        },
      ],
    });
  });
});
