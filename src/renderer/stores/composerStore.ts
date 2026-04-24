import { create } from 'zustand';
import type {
  BrowserSessionMode,
  ConversationEnvelopeContext,
  ConversationRoutingMode,
} from '@shared/contract/conversationEnvelope';
import {
  createWorkbenchRecipeMergedContext,
  createWorkbenchPresetContextFromSession,
  dedupeWorkbenchIds,
  normalizeWorkbenchPresetContext,
  type WorkbenchPreset,
  type WorkbenchPresetContext,
  type WorkbenchPresetSessionSource,
  type WorkbenchRecipe,
} from '@shared/contract/workbenchPreset';

interface ComposerState {
  workingDirectory: string | null;
  routingMode: ConversationRoutingMode;
  targetAgentIds: string[];
  browserSessionMode: BrowserSessionMode;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  hydratedSessionId: string | null;
  hydrateFromSession: (sessionId: string | null, workingDirectory: string | null) => void;
  applySessionWorkbenchPreset: (source: WorkbenchPresetSessionSource) => void;
  applyWorkbenchPreset: (preset: WorkbenchPreset | WorkbenchPresetContext) => void;
  applyWorkbenchRecipe: (recipe: WorkbenchRecipe) => void;
  setWorkingDirectory: (dir: string | null) => void;
  setRoutingMode: (mode: ConversationRoutingMode) => void;
  setTargetAgentIds: (ids: string[]) => void;
  setBrowserSessionMode: (mode: BrowserSessionMode) => void;
  setSelectedSkillIds: (ids: string[]) => void;
  setSelectedConnectorIds: (ids: string[]) => void;
  setSelectedMcpServerIds: (ids: string[]) => void;
  resetForSuccessfulSend: () => void;
  buildContext: () => ConversationEnvelopeContext | undefined;
}

const initialComposerState = {
  workingDirectory: null,
  routingMode: 'auto' as const,
  targetAgentIds: [],
  browserSessionMode: 'none' as const,
  selectedSkillIds: [],
  selectedConnectorIds: [],
  selectedMcpServerIds: [],
  hydratedSessionId: null,
};

function getWorkbenchPresetContext(
  preset: WorkbenchPreset | WorkbenchPresetContext,
): WorkbenchPresetContext {
  return normalizeWorkbenchPresetContext('context' in preset ? preset.context : preset);
}

function applyWorkbenchPresetContext(
  state: ComposerState,
  context: WorkbenchPresetContext,
): Partial<ComposerState> {
  return {
    workingDirectory: context.workingDirectory ?? state.workingDirectory,
    routingMode: context.routingMode,
    targetAgentIds: context.routingMode === 'direct' ? context.targetAgentIds : [],
    browserSessionMode: context.browserSessionMode,
    selectedSkillIds: context.selectedSkillIds,
    selectedConnectorIds: context.selectedConnectorIds,
    selectedMcpServerIds: context.selectedMcpServerIds,
  };
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  ...initialComposerState,

  hydrateFromSession: (sessionId, workingDirectory) =>
    set((state) => {
      if (state.hydratedSessionId !== sessionId) {
        return {
          ...state,
          hydratedSessionId: sessionId,
          workingDirectory,
          routingMode: 'auto',
          targetAgentIds: [],
          browserSessionMode: 'none',
          selectedSkillIds: [],
          selectedConnectorIds: [],
          selectedMcpServerIds: [],
        };
      }

      if (state.workingDirectory !== workingDirectory) {
        return {
          ...state,
          workingDirectory,
        };
      }

      return state;
    }),

  applySessionWorkbenchPreset: (source) =>
    set((state) => ({
      ...state,
      ...applyWorkbenchPresetContext(
        state,
        createWorkbenchPresetContextFromSession(source),
      ),
    })),

  applyWorkbenchPreset: (preset) =>
    set((state) => ({
      ...state,
      ...applyWorkbenchPresetContext(state, getWorkbenchPresetContext(preset)),
    })),

  applyWorkbenchRecipe: (recipe) =>
    set((state) => ({
      ...state,
      ...applyWorkbenchPresetContext(
        state,
        createWorkbenchRecipeMergedContext(recipe),
      ),
    })),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setRoutingMode: (mode) =>
    set((state) => ({
      routingMode: mode,
      targetAgentIds: mode === 'direct' ? state.targetAgentIds : [],
    })),

  setTargetAgentIds: (ids) =>
    set((state) => ({
      targetAgentIds: state.routingMode === 'direct' ? dedupeWorkbenchIds(ids) : [],
    })),

  setBrowserSessionMode: (mode) => set({ browserSessionMode: mode }),

  setSelectedSkillIds: (ids) =>
    set({
      selectedSkillIds: dedupeWorkbenchIds(ids),
    }),

  setSelectedConnectorIds: (ids) =>
    set({
      selectedConnectorIds: dedupeWorkbenchIds(ids),
    }),

  setSelectedMcpServerIds: (ids) =>
    set({
      selectedMcpServerIds: dedupeWorkbenchIds(ids),
    }),

  resetForSuccessfulSend: () =>
    set((state) => ({
      targetAgentIds: state.routingMode === 'direct' ? state.targetAgentIds : [],
    })),

  buildContext: () => {
    const state = get();
    const context: ConversationEnvelopeContext = {
      routing: {
        mode: state.routingMode,
      },
    };

    if (state.workingDirectory !== null) {
      context.workingDirectory = state.workingDirectory;
    }
    if (state.routingMode === 'direct' && state.targetAgentIds.length > 0) {
      context.routing = {
        mode: state.routingMode,
        targetAgentIds: [...state.targetAgentIds],
      };
    }
    if (state.selectedSkillIds.length > 0) {
      context.selectedSkillIds = [...state.selectedSkillIds];
    }
    if (state.selectedConnectorIds.length > 0) {
      context.selectedConnectorIds = [...state.selectedConnectorIds];
    }
    if (state.selectedMcpServerIds.length > 0) {
      context.selectedMcpServerIds = [...state.selectedMcpServerIds];
    }
    if (state.browserSessionMode === 'managed') {
      context.executionIntent = {
        browserSessionMode: 'managed',
        preferBrowserSession: true,
        allowBrowserAutomation: true,
      };
    } else if (state.browserSessionMode === 'desktop') {
      context.executionIntent = {
        browserSessionMode: 'desktop',
        preferBrowserSession: true,
        preferDesktopContext: true,
        allowBrowserAutomation: false,
      };
    }

    return Object.keys(context).length > 0 ? context : undefined;
  },
}));
