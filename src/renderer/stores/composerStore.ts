import { create } from 'zustand';
import type {
  BrowserSessionMode,
  ConversationEnvelopeContext,
  ConversationRoutingMode,
  TurnCapabilityScopeMode,
} from '@shared/contract/conversationEnvelope';
import type { SelectedElementInfo } from '@shared/livePreview/protocol';
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
import { useAppStore, type LivePreviewSelectedElement } from './appStore';

// appStore 存的是 flat 结构（来自 LivePreviewFrame 的 toSelectedElement），
// envelope 走 shared/livePreview/protocol.ts 的 nested SelectedElementInfo 形。
// 这里在 composer 侧把 flat 拍回 nested，让 main 侧只看到协议统一的一种形。
function toEnvelopeSelection(flat: LivePreviewSelectedElement): SelectedElementInfo {
  return {
    location: { file: flat.file, line: flat.line, column: flat.column },
    tag: flat.tag,
    text: flat.text,
    rect: flat.rect,
    ...(flat.componentName ? { componentName: flat.componentName } : {}),
  };
}

function readActiveLivePreviewSelection(): SelectedElementInfo | null {
  const appState = useAppStore.getState();
  const activeId = appState.activePreviewTabId;
  if (!activeId) return null;
  const tab = appState.previewTabs.find((t) => t.id === activeId);
  if (tab?.kind !== 'liveDev' || !tab.selectedElement) return null;
  return toEnvelopeSelection(tab.selectedElement);
}

interface ComposerState {
  workingDirectory: string | null;
  routingMode: ConversationRoutingMode;
  targetAgentIds: string[];
  browserSessionMode: BrowserSessionMode;
  selectedSkillIds: string[];
  selectedConnectorIds: string[];
  selectedMcpServerIds: string[];
  turnCapabilityScopeMode: TurnCapabilityScopeMode;
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
  setTurnCapabilityScopeMode: (mode: TurnCapabilityScopeMode) => void;
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
  turnCapabilityScopeMode: 'auto' as const,
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
    turnCapabilityScopeMode: context.turnCapabilityScopeMode ?? (
      context.selectedSkillIds.length || context.selectedConnectorIds.length || context.selectedMcpServerIds.length
        ? 'manual'
        : 'auto'
    ),
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
          turnCapabilityScopeMode: 'auto',
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
      turnCapabilityScopeMode: 'manual',
    }),

  setSelectedConnectorIds: (ids) =>
    set({
      selectedConnectorIds: dedupeWorkbenchIds(ids),
      turnCapabilityScopeMode: 'manual',
    }),

  setSelectedMcpServerIds: (ids) =>
    set({
      selectedMcpServerIds: dedupeWorkbenchIds(ids),
      turnCapabilityScopeMode: 'manual',
    }),

  setTurnCapabilityScopeMode: (mode) =>
    set((state) => ({
      turnCapabilityScopeMode: mode,
      ...(mode === 'auto'
        ? {
            selectedSkillIds: [],
            selectedConnectorIds: [],
            selectedMcpServerIds: [],
          }
        : {
            selectedSkillIds: state.selectedSkillIds,
            selectedConnectorIds: state.selectedConnectorIds,
            selectedMcpServerIds: state.selectedMcpServerIds,
          }),
    })),

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
    context.turnCapabilityScopeMode = state.turnCapabilityScopeMode;
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

    const livePreviewSelection = readActiveLivePreviewSelection();
    if (livePreviewSelection) {
      context.livePreviewSelection = livePreviewSelection;
    }

    return Object.keys(context).length > 0 ? context : undefined;
  },
}));
