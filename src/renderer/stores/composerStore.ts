import { create } from 'zustand';
import type {
  BrowserSessionMode,
  ConversationEnvelopeContext,
  ConversationRoutingMode,
} from '@shared/contract/conversationEnvelope';
import type { Session } from '@shared/contract/session';

type SessionWorkbenchPresetSource = Pick<
  Session,
  'workingDirectory' | 'workbenchSnapshot' | 'workbenchProvenance'
>;

function dedupeIds(ids?: string[]): string[] {
  return Array.from(new Set((ids ?? []).filter(Boolean)));
}

function resolvePresetWorkingDirectory(source: SessionWorkbenchPresetSource): string | null {
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
  applySessionWorkbenchPreset: (source: SessionWorkbenchPresetSource) => void;
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
    set((state) => {
      const targetAgentIds = dedupeIds(source.workbenchProvenance?.targetAgentIds);
      const requestedRoutingMode =
        source.workbenchProvenance?.routingMode ?? source.workbenchSnapshot?.routingMode ?? 'auto';
      const routingMode =
        requestedRoutingMode === 'direct' && targetAgentIds.length === 0
          ? 'auto'
          : requestedRoutingMode;
      const nextWorkingDirectory = resolvePresetWorkingDirectory(source);

      return {
        ...state,
        workingDirectory: nextWorkingDirectory ?? state.workingDirectory,
        routingMode,
        targetAgentIds: routingMode === 'direct' ? targetAgentIds : [],
        browserSessionMode: source.workbenchProvenance?.executionIntent?.browserSessionMode ?? 'none',
        selectedSkillIds: dedupeIds(
          source.workbenchProvenance?.selectedSkillIds ?? source.workbenchSnapshot?.skillIds,
        ),
        selectedConnectorIds: dedupeIds(
          source.workbenchProvenance?.selectedConnectorIds ?? source.workbenchSnapshot?.connectorIds,
        ),
        selectedMcpServerIds: dedupeIds(
          source.workbenchProvenance?.selectedMcpServerIds ?? source.workbenchSnapshot?.mcpServerIds,
        ),
      };
    }),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setRoutingMode: (mode) =>
    set((state) => ({
      routingMode: mode,
      targetAgentIds: mode === 'direct' ? state.targetAgentIds : [],
    })),

  setTargetAgentIds: (ids) =>
    set((state) => ({
      targetAgentIds: state.routingMode === 'direct' ? Array.from(new Set(ids)) : [],
    })),

  setBrowserSessionMode: (mode) => set({ browserSessionMode: mode }),

  setSelectedSkillIds: (ids) =>
    set({
      selectedSkillIds: Array.from(new Set(ids)),
    }),

  setSelectedConnectorIds: (ids) =>
    set({
      selectedConnectorIds: Array.from(new Set(ids)),
    }),

  setSelectedMcpServerIds: (ids) =>
    set({
      selectedMcpServerIds: Array.from(new Set(ids)),
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
