import type {
  BrowserSessionMode,
  ConversationExecutionIntent,
  ConversationRoutingMode,
} from './conversationEnvelope';
import type {
  SessionWorkbenchProvenance,
  SessionWorkbenchSnapshot,
} from './sessionWorkspace';

export const WORKBENCH_PRESET_CONTRACT_VERSION = 1;

export interface WorkbenchPresetSessionSource {
  id?: string;
  title?: string;
  workingDirectory?: string | null;
  updatedAt?: number;
  workbenchSnapshot?: SessionWorkbenchSnapshot;
  workbenchProvenance?: SessionWorkbenchProvenance;
}

export interface WorkbenchPresetContext {
  workingDirectory?: string | null;
  routingMode: ConversationRoutingMode;
  targetAgentIds: string[];
  browserSessionMode: BrowserSessionMode;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  executionIntent?: ConversationExecutionIntent;
  snapshot?: SessionWorkbenchSnapshot;
}

export type WorkbenchPresetSource =
  | {
      kind: 'session';
      sessionId?: string;
      sessionTitle?: string;
      capturedAt?: number;
      snapshotSummary?: string;
    }
  | {
      kind: 'manual';
    };

export interface WorkbenchPreset {
  version: typeof WORKBENCH_PRESET_CONTRACT_VERSION;
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  source: WorkbenchPresetSource;
  context: WorkbenchPresetContext;
}

export interface WorkbenchRecipeStep {
  id: string;
  name: string;
  presetId?: string;
  context?: WorkbenchPresetContext;
  notes?: string;
}

export interface WorkbenchRecipe {
  version: typeof WORKBENCH_PRESET_CONTRACT_VERSION;
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  source?: WorkbenchPresetSource;
  steps: WorkbenchRecipeStep[];
}

export interface CreateWorkbenchRecipeFromPresetsOptions {
  id?: string;
  name?: string;
  description?: string;
  source?: WorkbenchPresetSource;
  now?: number;
}

export function dedupeWorkbenchIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

export function resolveWorkbenchPresetWorkingDirectory(
  source: WorkbenchPresetSessionSource,
): string | null {
  const candidates = [
    source.workbenchProvenance?.workingDirectory,
    source.workingDirectory,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

function cloneExecutionIntent(
  intent: ConversationExecutionIntent | undefined,
  browserSessionMode: BrowserSessionMode,
): ConversationExecutionIntent | undefined {
  const cloned = intent
    ? {
        ...intent,
        browserSessionSnapshot: intent.browserSessionSnapshot
          ? {
              ...intent.browserSessionSnapshot,
              preview: intent.browserSessionSnapshot.preview
                ? { ...intent.browserSessionSnapshot.preview }
                : undefined,
            }
          : undefined,
      }
    : undefined;

  if (browserSessionMode === 'none') {
    if (!cloned) {
      return undefined;
    }
    const { browserSessionMode: _browserSessionMode, ...withoutBrowserMode } = cloned;
    return Object.keys(withoutBrowserMode).length > 0 ? withoutBrowserMode : undefined;
  }

  return {
    ...cloned,
    browserSessionMode,
  };
}

export function normalizeWorkbenchPresetContext(
  context: WorkbenchPresetContext,
): WorkbenchPresetContext {
  const targetAgentIds = dedupeWorkbenchIds(context.targetAgentIds);
  const requestedRoutingMode = context.routingMode || 'auto';
  const routingMode =
    requestedRoutingMode === 'direct' && targetAgentIds.length === 0
      ? 'auto'
      : requestedRoutingMode;
  const workingDirectory = context.workingDirectory?.trim() || null;
  const browserSessionMode =
    context.browserSessionMode === 'none'
      ? context.executionIntent?.browserSessionMode ?? 'none'
      : context.browserSessionMode;

  return {
    workingDirectory,
    routingMode,
    targetAgentIds: routingMode === 'direct' ? targetAgentIds : [],
    browserSessionMode,
    selectedSkillIds: dedupeWorkbenchIds(context.selectedSkillIds),
    selectedConnectorIds: dedupeWorkbenchIds(context.selectedConnectorIds),
    selectedMcpServerIds: dedupeWorkbenchIds(context.selectedMcpServerIds),
    executionIntent: cloneExecutionIntent(context.executionIntent, browserSessionMode),
    snapshot: context.snapshot
      ? {
          ...context.snapshot,
          labels: [...context.snapshot.labels],
          recentToolNames: [...context.snapshot.recentToolNames],
          skillIds: context.snapshot.skillIds ? [...context.snapshot.skillIds] : undefined,
          connectorIds: context.snapshot.connectorIds ? [...context.snapshot.connectorIds] : undefined,
          mcpServerIds: context.snapshot.mcpServerIds ? [...context.snapshot.mcpServerIds] : undefined,
        }
      : undefined,
  };
}

export function createWorkbenchPresetContextFromSession(
  source: WorkbenchPresetSessionSource,
): WorkbenchPresetContext {
  const provenance = source.workbenchProvenance;
  const snapshot = source.workbenchSnapshot;
  const targetAgentIds = dedupeWorkbenchIds(provenance?.targetAgentIds);
  const requestedRoutingMode =
    provenance?.routingMode ?? snapshot?.routingMode ?? 'auto';
  const browserSessionMode =
    provenance?.executionIntent?.browserSessionMode ?? 'none';

  return normalizeWorkbenchPresetContext({
    workingDirectory: resolveWorkbenchPresetWorkingDirectory(source),
    routingMode: requestedRoutingMode,
    targetAgentIds,
    browserSessionMode,
    selectedSkillIds: dedupeWorkbenchIds(
      provenance?.selectedSkillIds ?? snapshot?.skillIds,
    ),
    selectedConnectorIds: dedupeWorkbenchIds(
      provenance?.selectedConnectorIds ?? snapshot?.connectorIds,
    ),
    selectedMcpServerIds: dedupeWorkbenchIds(
      provenance?.selectedMcpServerIds ?? snapshot?.mcpServerIds,
    ),
    executionIntent: provenance?.executionIntent,
    snapshot,
  });
}

export function hasWorkbenchPresetContext(
  context: WorkbenchPresetContext,
): boolean {
  return Boolean(
    context.workingDirectory?.trim() ||
      context.routingMode !== 'auto' ||
      context.targetAgentIds.length > 0 ||
      context.browserSessionMode !== 'none' ||
      context.selectedSkillIds.length > 0 ||
      context.selectedConnectorIds.length > 0 ||
      context.selectedMcpServerIds.length > 0,
  );
}

export function getDefaultWorkbenchPresetName(
  source: WorkbenchPresetSessionSource,
): string {
  const rawName =
    source.title?.trim() ||
    source.workbenchSnapshot?.summary?.trim() ||
    'Workbench preset';
  return rawName.length > 60 ? `${rawName.slice(0, 57)}...` : rawName;
}

function createWorkbenchPresetId(now: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `workbench-preset-${uuid}`;
  }
  return `workbench-preset-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function createWorkbenchRecipeId(now: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return `workbench-recipe-${uuid}`;
  }
  return `workbench-recipe-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeWorkbenchPresetSource(
  source: WorkbenchPresetSource | undefined,
): WorkbenchPresetSource | undefined {
  if (!source) {
    return undefined;
  }

  if (source.kind !== 'session') {
    return { kind: 'manual' };
  }

  return {
    kind: 'session',
    sessionId: source.sessionId?.trim() || undefined,
    sessionTitle: source.sessionTitle?.trim() || undefined,
    capturedAt: source.capturedAt,
    snapshotSummary: source.snapshotSummary?.trim() || undefined,
  };
}

function normalizeWorkbenchRecipeStep(
  step: WorkbenchRecipeStep,
  index: number,
  recipeId: string,
): WorkbenchRecipeStep {
  return {
    id: step.id.trim() || `${recipeId}-step-${index + 1}`,
    name: step.name.trim() || 'Recipe step',
    presetId: step.presetId?.trim() || undefined,
    context: step.context
      ? normalizeWorkbenchPresetContext(step.context)
      : undefined,
    notes: step.notes?.trim() || undefined,
  };
}

export function normalizeWorkbenchRecipe(recipe: WorkbenchRecipe): WorkbenchRecipe {
  const now = Date.now();
  const recipeId = recipe.id.trim() || createWorkbenchRecipeId(now);

  return {
    version: WORKBENCH_PRESET_CONTRACT_VERSION,
    id: recipeId,
    name: recipe.name.trim() || 'Workbench recipe',
    description: recipe.description?.trim() || undefined,
    createdAt: recipe.createdAt || now,
    updatedAt: recipe.updatedAt || recipe.createdAt || now,
    source: normalizeWorkbenchPresetSource(recipe.source),
    steps: recipe.steps
      .map((step, index) => normalizeWorkbenchRecipeStep(step, index, recipeId))
      .filter((step) => Boolean(step.presetId || step.context)),
  };
}

export function createWorkbenchPresetFromSession(
  source: WorkbenchPresetSessionSource,
  options: {
    id?: string;
    name?: string;
    description?: string;
    now?: number;
  } = {},
): WorkbenchPreset | null {
  const context = createWorkbenchPresetContextFromSession(source);
  if (!hasWorkbenchPresetContext(context)) {
    return null;
  }

  const now = options.now ?? Date.now();
  const name = (options.name?.trim() || getDefaultWorkbenchPresetName(source)).trim();

  return {
    version: WORKBENCH_PRESET_CONTRACT_VERSION,
    id: options.id || createWorkbenchPresetId(now),
    name,
    description: options.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    source: {
      kind: 'session',
      sessionId: source.id,
      sessionTitle: source.title,
      capturedAt: source.workbenchProvenance?.capturedAt ?? source.updatedAt,
      snapshotSummary: source.workbenchSnapshot?.summary,
    },
    context,
  };
}

export function createWorkbenchRecipeFromPresets(
  presets: WorkbenchPreset[],
  options: CreateWorkbenchRecipeFromPresetsOptions = {},
): WorkbenchRecipe | null {
  const normalizedPresets = presets.map((preset) => ({
    ...preset,
    context: normalizeWorkbenchPresetContext(preset.context),
  }));
  const steps = normalizedPresets
    .filter((preset) => hasWorkbenchPresetContext(preset.context))
    .map((preset, index): WorkbenchRecipeStep => ({
      id: `step-${index + 1}-${preset.id.trim() || 'preset'}`,
      name: preset.name.trim() || `Step ${index + 1}`,
      presetId: preset.id.trim() || undefined,
      context: preset.context,
    }));

  if (steps.length === 0) {
    return null;
  }

  const now = options.now ?? Date.now();
  const recipeId = options.id?.trim() || createWorkbenchRecipeId(now);
  const defaultName =
    normalizedPresets.length === 1
      ? `${normalizedPresets[0].name.trim() || 'Workbench preset'} recipe`
      : `${normalizedPresets[0].name.trim() || 'Workbench'} + ${normalizedPresets.length - 1}`;

  return normalizeWorkbenchRecipe({
    version: WORKBENCH_PRESET_CONTRACT_VERSION,
    id: recipeId,
    name: options.name?.trim() || defaultName,
    description: options.description?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    source: options.source ?? { kind: 'manual' },
    steps,
  });
}

export function createWorkbenchRecipeMergedContext(
  recipe: WorkbenchRecipe,
): WorkbenchPresetContext {
  const normalizedRecipe = normalizeWorkbenchRecipe(recipe);
  const merged: WorkbenchPresetContext = {
    workingDirectory: null,
    routingMode: 'auto',
    targetAgentIds: [],
    browserSessionMode: 'none',
    selectedSkillIds: [],
    selectedConnectorIds: [],
    selectedMcpServerIds: [],
  };

  for (const step of normalizedRecipe.steps) {
    if (!step.context) {
      continue;
    }

    const context = normalizeWorkbenchPresetContext(step.context);
    if (context.workingDirectory?.trim()) {
      merged.workingDirectory = context.workingDirectory;
    }
    if (context.routingMode !== 'auto') {
      merged.routingMode = context.routingMode;
    }
    if (context.browserSessionMode !== 'none') {
      merged.browserSessionMode = context.browserSessionMode;
      merged.executionIntent = context.executionIntent;
    }
    if (context.snapshot) {
      merged.snapshot = context.snapshot;
    }

    merged.targetAgentIds = dedupeWorkbenchIds([
      ...merged.targetAgentIds,
      ...context.targetAgentIds,
    ]);
    merged.selectedSkillIds = dedupeWorkbenchIds([
      ...merged.selectedSkillIds,
      ...context.selectedSkillIds,
    ]);
    merged.selectedConnectorIds = dedupeWorkbenchIds([
      ...merged.selectedConnectorIds,
      ...context.selectedConnectorIds,
    ]);
    merged.selectedMcpServerIds = dedupeWorkbenchIds([
      ...merged.selectedMcpServerIds,
      ...context.selectedMcpServerIds,
    ]);
  }

  return normalizeWorkbenchPresetContext(merged);
}
