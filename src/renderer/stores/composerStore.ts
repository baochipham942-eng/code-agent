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
import type { PendingCommandSelection } from '../components/features/chat/ChatInput/pendingCommand';
import { setSessionPin } from '../services/libraryClient';
import { notifyLibraryPinChanged } from '../components/features/knowledge/libraryPinEvents';
import {
  DRAFT_SCOPE_KEY,
  emptyComposerSlot,
  isDraftOrSpaceScopeKey,
  isSessionScopeKey,
  planScopeHandoffToSession,
  sessionIdFromScopeKey,
  sessionScopeKey,
  snapshotComposerSlot,
  spaceScopeKey,
  type ComposerScopeKey,
  type ComposerSlotSnapshot,
} from './composerScopeModel';

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

function readLiveSlot(state: Pick<ComposerState, keyof ComposerSlotSnapshot>): ComposerSlotSnapshot {
  return snapshotComposerSlot({
    workingDirectory: state.workingDirectory,
    routingMode: state.routingMode,
    targetAgentIds: state.targetAgentIds,
    browserSessionMode: state.browserSessionMode,
    selectedSkillIds: state.selectedSkillIds,
    selectedConnectorIds: state.selectedConnectorIds,
    selectedMcpServerIds: state.selectedMcpServerIds,
    turnCapabilityScopeMode: state.turnCapabilityScopeMode,
    selectedTeamRecipeId: state.selectedTeamRecipeId,
    standbyExcludedMemberKeys: state.standbyExcludedMemberKeys,
    pendingCommand: state.pendingCommand,
    pendingPinItemIds: state.pendingPinItemIds,
    pendingActiveAgentId: state.pendingActiveAgentId,
  });
}

function liveFieldsFromSlot(slot: ComposerSlotSnapshot): ComposerSlotSnapshot {
  return snapshotComposerSlot(slot);
}

/**
 * 进入槽时同步专家选择：
 * - 会话槽：走 per-session map（syncActiveAgentForSession）
 * - 草稿/空间：断开 sessionKey，恢复槽内 pendingActiveAgentId（仅内存）
 */
function syncAgentForScope(key: ComposerScopeKey, slot: ComposerSlotSnapshot): void {
  const app = useAppStore.getState();
  if (isSessionScopeKey(key)) {
    const sessionId = sessionIdFromScopeKey(key);
    if (sessionId) app.syncActiveAgentForSession(sessionId);
    return;
  }
  // 非会话：不要误写到上一个会话的 map
  useAppStore.setState({
    activeAgentSessionKey: null,
    activeAgentId: slot.pendingActiveAgentId,
  });
}

/**
 * 离开草稿/空间前，把当前内存里的 activeAgentId 收进快照。
 * 会话槽的专家真源是 map，不靠 slot.pendingActiveAgentId。
 */
function withAgentIntentForSnapshot(
  key: ComposerScopeKey,
  live: ComposerSlotSnapshot,
): ComposerSlotSnapshot {
  if (isSessionScopeKey(key)) {
    return { ...live, pendingActiveAgentId: null };
  }
  return {
    ...live,
    pendingActiveAgentId: useAppStore.getState().activeAgentId,
  };
}

interface ComposerState extends ComposerSlotSnapshot {
  /**
   * 当前激活的上下文槽。切换时先快照再恢复；会话残留不得漏进空间/草稿。
   */
  activeScopeKey: ComposerScopeKey;
  /** 非激活槽的快照表。 */
  slots: Record<string, ComposerSlotSnapshot>;
  /**
   * 兼容旧调用点：当前会话槽的 sessionId；草稿/空间为 null。
   * hydrateFromSession 仍可写，语义 = activateScope(session|draft)。
   */
  hydratedSessionId: string | null;
  activateScope: (
    key: ComposerScopeKey,
    options?: { workingDirectory?: string | null },
  ) => void;
  /**
   * 从草稿/空间发起新会话：把发起槽全部选择移交给 session 槽，
   * pin 物化到 host，专家 bind 到新会话；发起槽清空。
   */
  handoffActiveScopeToSession: (newSessionId: string) => Promise<void>;
  setPendingPinItemIds: (ids: string[]) => void;
  togglePendingPinItemId: (itemId: string) => void;
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
  setSelectedTeamRecipeId: (id: string | null) => void;
  setStandbyExcludedMemberKeys: (keys: string[]) => void;
  setPendingCommand: (command: PendingCommandSelection | null) => void;
  resetForSuccessfulSend: () => void;
  buildContext: () => ConversationEnvelopeContext | undefined;
}

const initialSlot = emptyComposerSlot();

const initialComposerState = {
  ...initialSlot,
  activeScopeKey: DRAFT_SCOPE_KEY as ComposerScopeKey,
  slots: {} as Record<string, ComposerSlotSnapshot>,
  hydratedSessionId: null as string | null,
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

  activateScope: (key, options) => {
    const state = get();
    if (state.activeScopeKey === key) {
      if (options && 'workingDirectory' in options && options.workingDirectory !== state.workingDirectory) {
        set({ workingDirectory: options.workingDirectory ?? null });
      }
      return;
    }

    const leaving = withAgentIntentForSnapshot(state.activeScopeKey, readLiveSlot(state));
    const nextSlots: Record<string, ComposerSlotSnapshot> = {
      ...state.slots,
      [state.activeScopeKey]: leaving,
    };

    const stored = nextSlots[key];
    const incoming = stored
      ? liveFieldsFromSlot(stored)
      : emptyComposerSlot(
        options && 'workingDirectory' in options
          ? { workingDirectory: options.workingDirectory ?? null }
          : undefined,
      );

    if (options && 'workingDirectory' in options) {
      incoming.workingDirectory = options.workingDirectory ?? null;
    }

    // 进入后该槽已是 live，表里可保留一份同源快照，避免后续读 slots[key] 空
    nextSlots[key] = snapshotComposerSlot(incoming);

    set({
      ...incoming,
      activeScopeKey: key,
      slots: nextSlots,
      hydratedSessionId: sessionIdFromScopeKey(key),
    });
    syncAgentForScope(key, incoming);
  },

  handoffActiveScopeToSession: async (newSessionId) => {
    const state = get();
    if (!newSessionId) return;

    // 仅草稿/空间发起需要移交；已在会话里 create 新会话不抄技能/pin
    if (!isDraftOrSpaceScopeKey(state.activeScopeKey)) {
      get().activateScope(sessionScopeKey(newSessionId));
      return;
    }

    const live = withAgentIntentForSnapshot(state.activeScopeKey, readLiveSlot(state));
    const plan = planScopeHandoffToSession({
      slots: state.slots,
      sourceKey: state.activeScopeKey,
      sourceLive: live,
      newSessionId,
    });

    // 先落 live = 会话槽，避免后续 hydrate 看到空槽再清空
    set({
      ...plan.sessionSlot,
      activeScopeKey: plan.sessionKey,
      slots: plan.nextSlots,
      hydratedSessionId: newSessionId,
    });

    if (plan.activeAgentId) {
      useAppStore.getState().bindAgentForSession(newSessionId, plan.activeAgentId);
    } else {
      useAppStore.getState().syncActiveAgentForSession(newSessionId);
    }

    if (plan.pinItemIds.length > 0) {
      try {
        await setSessionPin(newSessionId, plan.pinItemIds);
        notifyLibraryPinChanged(newSessionId);
      } catch {
        // pin 物化失败不阻断发会话；槽内已无 pending，用户可在会话里重 pin
      }
    }
  },

  setPendingPinItemIds: (ids) =>
    set({ pendingPinItemIds: dedupeWorkbenchIds(ids) }),

  togglePendingPinItemId: (itemId) =>
    set((state) => {
      const has = state.pendingPinItemIds.includes(itemId);
      return {
        pendingPinItemIds: has
          ? state.pendingPinItemIds.filter((id) => id !== itemId)
          : dedupeWorkbenchIds([...state.pendingPinItemIds, itemId]),
      };
    }),

  hydrateFromSession: (sessionId, workingDirectory) => {
    const key = sessionId ? sessionScopeKey(sessionId) : DRAFT_SCOPE_KEY;
    get().activateScope(key, { workingDirectory });
  },

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

  // 换配方（或取消预选）时旧的排除标记一并作废——排除只隶属于当前这次预选
  setSelectedTeamRecipeId: (id) => set({ selectedTeamRecipeId: id, standbyExcludedMemberKeys: [] }),

  setStandbyExcludedMemberKeys: (keys) => set({ standbyExcludedMemberKeys: keys }),

  setPendingCommand: (command) => set({ pendingCommand: command }),

  resetForSuccessfulSend: () =>
    set((state) => ({
      targetAgentIds: state.routingMode === 'direct' ? state.targetAgentIds : [],
      // 配方已经启动，预选态就该退场——留着会让下一句话又想启动一次
      selectedTeamRecipeId: null,
      standbyExcludedMemberKeys: [],
      pendingCommand: null,
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

export { DRAFT_SCOPE_KEY, sessionScopeKey, spaceScopeKey };
export type { ComposerScopeKey, ComposerSlotSnapshot };
