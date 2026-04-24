import { create } from 'zustand';
import type {
  BrowserSessionMode,
  ConversationExecutionIntent,
  ConversationRoutingMode,
} from '@shared/contract/conversationEnvelope';
import {
  WORKBENCH_PRESET_CONTRACT_VERSION,
  createWorkbenchRecipeFromPresets,
  createWorkbenchPresetFromSession,
  normalizeWorkbenchRecipe,
  normalizeWorkbenchPresetContext,
  type CreateWorkbenchRecipeFromPresetsOptions,
  type WorkbenchPreset,
  type WorkbenchPresetContext,
  type WorkbenchPresetSessionSource,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';

export const WORKBENCH_PRESET_STORAGE_KEY = 'workbench.presets.v1';
const MAX_LOCAL_PRESETS = 50;

interface PersistedWorkbenchPresetLibrary {
  version: typeof WORKBENCH_PRESET_CONTRACT_VERSION;
  presets: WorkbenchPreset[];
  recipes: WorkbenchRecipe[];
}

interface SavePresetOptions {
  id?: string;
  name?: string;
  description?: string;
  now?: number;
}

interface WorkbenchPresetState {
  presets: WorkbenchPreset[];
  recipes: WorkbenchRecipe[];
  hasHydrated: boolean;
  hydrate: () => void;
  savePresetFromSession: (
    session: WorkbenchPresetSessionSource,
    options?: SavePresetOptions,
  ) => WorkbenchPreset | null;
  upsertPreset: (preset: WorkbenchPreset) => WorkbenchPreset;
  renamePreset: (presetId: string, name: string, now?: number) => void;
  deletePreset: (presetId: string) => void;
  clearPresets: () => void;
  getPresetById: (presetId: string) => WorkbenchPreset | undefined;
  createRecipeFromPresets: (
    presets: WorkbenchPreset[],
    options?: CreateWorkbenchRecipeFromPresetsOptions,
  ) => WorkbenchRecipe | null;
  upsertRecipe: (recipe: WorkbenchRecipe) => WorkbenchRecipe;
  deleteRecipe: (recipeId: string) => void;
  clearRecipes: () => void;
  getRecipeById: (recipeId: string) => WorkbenchRecipe | undefined;
  listRecipes: () => WorkbenchRecipe[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toRoutingMode(value: unknown): ConversationRoutingMode {
  return value === 'direct' || value === 'parallel' ? value : 'auto';
}

function toBrowserSessionMode(value: unknown): BrowserSessionMode {
  return value === 'managed' || value === 'desktop' ? value : 'none';
}

function coerceSnapshot(value: unknown): WorkbenchPresetContext['snapshot'] | undefined {
  if (!isRecord(value) || typeof value.summary !== 'string') {
    return undefined;
  }

  return {
    summary: value.summary,
    labels: toStringArray(value.labels),
    recentToolNames: toStringArray(value.recentToolNames),
    primarySurface: value.primarySurface === 'workspace' ||
      value.primarySurface === 'browser' ||
      value.primarySurface === 'desktop' ||
      value.primarySurface === 'connector' ||
      value.primarySurface === 'chat'
      ? value.primarySurface
      : undefined,
    evidenceSource: value.evidenceSource === 'message_metadata' ||
      value.evidenceSource === 'tool_history' ||
      value.evidenceSource === 'session_provenance' ||
      value.evidenceSource === 'session_metadata'
      ? value.evidenceSource
      : undefined,
    workspaceLabel: typeof value.workspaceLabel === 'string' ? value.workspaceLabel : undefined,
    routingMode: toRoutingMode(value.routingMode),
    skillIds: toStringArray(value.skillIds),
    connectorIds: toStringArray(value.connectorIds),
    mcpServerIds: toStringArray(value.mcpServerIds),
  };
}

function coerceContext(value: unknown): WorkbenchPresetContext | null {
  if (!isRecord(value)) {
    return null;
  }

  return normalizeWorkbenchPresetContext({
    workingDirectory: typeof value.workingDirectory === 'string' ? value.workingDirectory : null,
    routingMode: toRoutingMode(value.routingMode),
    targetAgentIds: toStringArray(value.targetAgentIds),
    browserSessionMode: toBrowserSessionMode(value.browserSessionMode),
    selectedSkillIds: toStringArray(value.selectedSkillIds),
    selectedConnectorIds: toStringArray(value.selectedConnectorIds),
    selectedMcpServerIds: toStringArray(value.selectedMcpServerIds),
    executionIntent: isRecord(value.executionIntent)
      ? value.executionIntent as ConversationExecutionIntent
      : undefined,
    snapshot: coerceSnapshot(value.snapshot),
  });
}

function normalizePreset(value: unknown): WorkbenchPreset | null {
  if (!isRecord(value)) {
    return null;
  }

  const context = coerceContext(value.context);
  if (!context || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }

  return {
    version: WORKBENCH_PRESET_CONTRACT_VERSION,
    id: value.id,
    name: value.name.trim() || 'Workbench preset',
    description: typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : undefined,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    source: isRecord(value.source) && value.source.kind === 'session'
      ? {
          kind: 'session',
          sessionId: typeof value.source.sessionId === 'string' ? value.source.sessionId : undefined,
          sessionTitle: typeof value.source.sessionTitle === 'string' ? value.source.sessionTitle : undefined,
          capturedAt: typeof value.source.capturedAt === 'number' ? value.source.capturedAt : undefined,
          snapshotSummary: typeof value.source.snapshotSummary === 'string' ? value.source.snapshotSummary : undefined,
        }
      : { kind: 'manual' },
    context,
  };
}

function normalizeRecipe(value: unknown): WorkbenchRecipe | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') {
    return null;
  }

  return normalizeWorkbenchRecipe({
    version: WORKBENCH_PRESET_CONTRACT_VERSION,
    id: value.id,
    name: value.name.trim() || 'Workbench recipe',
    description: typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : undefined,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    source: isRecord(value.source) && value.source.kind === 'session'
      ? {
          kind: 'session',
          sessionId: typeof value.source.sessionId === 'string' ? value.source.sessionId : undefined,
          sessionTitle: typeof value.source.sessionTitle === 'string' ? value.source.sessionTitle : undefined,
          capturedAt: typeof value.source.capturedAt === 'number' ? value.source.capturedAt : undefined,
          snapshotSummary: typeof value.source.snapshotSummary === 'string' ? value.source.snapshotSummary : undefined,
        }
      : isRecord(value.source) && value.source.kind === 'manual'
        ? { kind: 'manual' }
        : undefined,
    steps: Array.isArray(value.steps) ? value.steps.filter(isRecord).map((step) => ({
      id: typeof step.id === 'string' ? step.id : '',
      name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : 'Recipe step',
      presetId: typeof step.presetId === 'string' ? step.presetId : undefined,
      context: coerceContext(step.context) ?? undefined,
      notes: typeof step.notes === 'string' ? step.notes : undefined,
    })) : [],
  });
}

function readLibrary(): PersistedWorkbenchPresetLibrary {
  try {
    if (typeof localStorage === 'undefined') {
      return {
        version: WORKBENCH_PRESET_CONTRACT_VERSION,
        presets: [],
        recipes: [],
      };
    }

    const raw = localStorage.getItem(WORKBENCH_PRESET_STORAGE_KEY);
    if (!raw) {
      return {
        version: WORKBENCH_PRESET_CONTRACT_VERSION,
        presets: [],
        recipes: [],
      };
    }

    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error('Invalid workbench preset storage payload');
    }

    return {
      version: WORKBENCH_PRESET_CONTRACT_VERSION,
      presets: Array.isArray(parsed.presets)
        ? parsed.presets.map(normalizePreset).filter((preset): preset is WorkbenchPreset => Boolean(preset))
        : [],
      recipes: Array.isArray(parsed.recipes)
        ? parsed.recipes.map(normalizeRecipe).filter((recipe): recipe is WorkbenchRecipe => Boolean(recipe))
        : [],
    };
  } catch {
    return {
      version: WORKBENCH_PRESET_CONTRACT_VERSION,
      presets: [],
      recipes: [],
    };
  }
}

function writeLibrary(library: Pick<PersistedWorkbenchPresetLibrary, 'presets' | 'recipes'>): void {
  try {
    if (typeof localStorage === 'undefined') {
      return;
    }

    localStorage.setItem(
      WORKBENCH_PRESET_STORAGE_KEY,
      JSON.stringify({
        version: WORKBENCH_PRESET_CONTRACT_VERSION,
        presets: library.presets,
        recipes: library.recipes,
      }),
    );
  } catch {
    // localStorage can be disabled; the in-memory store still remains usable.
  }
}

function persistAndReturn(
  presets: WorkbenchPreset[],
  recipes: WorkbenchRecipe[],
): Pick<WorkbenchPresetState, 'presets' | 'recipes'> {
  const next = {
    presets: presets.slice(0, MAX_LOCAL_PRESETS),
    recipes,
  };
  writeLibrary(next);
  return next;
}

const initialLibrary = readLibrary();

export const useWorkbenchPresetStore = create<WorkbenchPresetState>((set, get) => ({
  presets: initialLibrary.presets,
  recipes: initialLibrary.recipes,
  hasHydrated: true,

  hydrate: () => {
    const next = readLibrary();
    set({
      presets: next.presets,
      recipes: next.recipes,
      hasHydrated: true,
    });
  },

  savePresetFromSession: (session, options = {}) => {
    const preset = createWorkbenchPresetFromSession(session, options);
    if (!preset) {
      return null;
    }

    set((state) => persistAndReturn(
      [preset, ...state.presets.filter((item) => item.id !== preset.id)],
      state.recipes,
    ));

    return preset;
  },

  upsertPreset: (preset) => {
    const normalizedPreset: WorkbenchPreset = {
      ...preset,
      version: WORKBENCH_PRESET_CONTRACT_VERSION,
      context: normalizeWorkbenchPresetContext(preset.context),
      updatedAt: preset.updatedAt || Date.now(),
    };

    set((state) => persistAndReturn(
      [normalizedPreset, ...state.presets.filter((item) => item.id !== normalizedPreset.id)],
      state.recipes,
    ));

    return normalizedPreset;
  },

  renamePreset: (presetId, name, now = Date.now()) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }

    set((state) => persistAndReturn(
      state.presets.map((preset) =>
        preset.id === presetId
          ? { ...preset, name: trimmed, updatedAt: now }
          : preset,
      ),
      state.recipes,
    ));
  },

  deletePreset: (presetId) => {
    set((state) => persistAndReturn(
      state.presets.filter((preset) => preset.id !== presetId),
      state.recipes,
    ));
  },

  clearPresets: () => {
    set((state) => persistAndReturn([], state.recipes));
  },

  getPresetById: (presetId) => get().presets.find((preset) => preset.id === presetId),

  createRecipeFromPresets: (presets, options = {}) => {
    const recipe = createWorkbenchRecipeFromPresets(presets, options);
    if (!recipe) {
      return null;
    }

    set((state) => persistAndReturn(
      state.presets,
      [recipe, ...state.recipes.filter((item) => item.id !== recipe.id)],
    ));

    return recipe;
  },

  upsertRecipe: (recipe) => {
    const normalizedRecipe = normalizeWorkbenchRecipe(recipe);

    set((state) => persistAndReturn(
      state.presets,
      [normalizedRecipe, ...state.recipes.filter((item) => item.id !== normalizedRecipe.id)],
    ));

    return normalizedRecipe;
  },

  deleteRecipe: (recipeId) => {
    set((state) => persistAndReturn(
      state.presets,
      state.recipes.filter((recipe) => recipe.id !== recipeId),
    ));
  },

  clearRecipes: () => {
    set((state) => persistAndReturn(state.presets, []));
  },

  getRecipeById: (recipeId) => get().recipes.find((recipe) => recipe.id === recipeId),

  listRecipes: () => [...get().recipes],
}));
