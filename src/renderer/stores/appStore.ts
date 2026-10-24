// ============================================================================
// App Store - Global Application State
// ============================================================================

import { useWorkbenchFocusStore } from './workbenchFocusStore';
import { create } from 'zustand';
import type {
  ModelConfig,
  PermissionRequest,
} from '@shared/contract';
import type { ContextHealthState } from '@shared/contract/contextHealth';

export function preserveLatestCompressionSignal(
  next: ContextHealthState | null | undefined,
  previous: ContextHealthState | null | undefined,
): ContextHealthState | null | undefined {
  if (!next || !previous?.compression?.lastSignal) return next;
  const nextSignal = next.compression?.lastSignal;
  const previousSignal = previous.compression.lastSignal;
  if (nextSignal && nextSignal.timestamp >= previousSignal.timestamp) return next;
  return {
    ...next,
    compression: {
      ...(next.compression ?? { status: 'none', compressionCount: 0, totalSavedTokens: 0 }),
      lastSignal: previousSignal,
    },
  };
}
import { defaultLanguage } from '../i18n';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  MODEL_MAX_TOKENS,
  getProviderEndpoint,
} from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import { invokeDomain } from '../services/ipcService';
import { resolveSettingsDeepLink } from '../utils/settingsTabs';
import {
  dropLegacyActiveAgentKey,
  readActiveAgentSessionMap,
  writeActiveAgentSessionMap,
} from './activeAgentSessionMap';
import { noteSurfaceIntentNavigation } from '../services/surfaceIntentRuntime';
import {
  isPreviewWorkbenchView,
  type PreviewWorkbenchViewId,
  type WorkbenchViewId,
} from '../utils/workbenchViews';
import { createWorkbenchActions } from './workbenchActions';
import { SECONDARY_PAGES_CLOSED } from './secondaryPages';
import { buildContentPreviewState } from './contentPreviewState';
import { buildPermissionDecisionState, buildPermissionDismissState } from './permissionDecisionState';
import { installedBundledCapabilityIds } from './bundledCapabilityStore';

// V2-A: 关 tab 时 fire-and-forget 调 stopDevServer。lazy import 避免
// 在 store 模块顶层引入 ipcService（store 是大量被 import 的模块，链路尽量短）
function fireStopDevServer(sessionId: string | undefined): void {
  if (!sessionId) return;
  void (async () => {
    try {
      await invokeDomain(IPC_DOMAINS.LIVE_PREVIEW, 'stopDevServer', { sessionId });
    } catch (err) {
      console.warn('[appStore] stopDevServer failed for', sessionId, err);
    }
  })();
}

// 纯类型/常量已搬至 ./appStoreTypes（N-MAXLINES-MINEFIELD-2-FU1-S10）：此处 import 自用，
// 并逐名 re-export 保持公共导出面不变（消费方零改动）。
import type { AppState, PreviewTab } from './appStoreTypes';
import { MAX_PREVIEW_TABS } from './appStoreTypes';
export type {
  AppState,
  ContentPreviewInput,
  DisclosureLevel,
  GoalRunState,
  LivePreviewSelectedElement,
  LocalOpsTab,
  OpenWorkbenchTabOptions,
  PendingProjectGoalChatSeed,
  PreviewTab,
  SettingsCapabilityFocus,
  SettingsMemoryFocus,
  TaskPanelTab,
  WorkbenchHighlight,
  WorkbenchOpenSource,
} from './appStoreTypes';
export { MAX_PREVIEW_TABS } from './appStoreTypes';

// 设置页 Tab 类型
export type { SettingsTab } from '../utils/settingsTabs';
export type { CapabilityHubTab } from '../utils/settingsTabs';
export type { WorkbenchTabId, WorkbenchViewId } from '../utils/workbenchViews';

// Monotonic tick for tab lastActivatedAt — avoids Date.now() collisions
// when several activations fire in the same millisecond.
let _previewTabTick = 0;
const nextPreviewTabTick = () => ++_previewTabTick;
let _settingsMemoryFocusTick = 0;
const nextSettingsMemoryFocusNonce = () => ++_settingsMemoryFocusTick;
let _settingsCapabilityFocusTick = 0;
const nextSettingsCapabilityFocusNonce = () => ++_settingsCapabilityFocusTick;

const GLOBAL_PERMISSION_REQUEST_SESSION_ID = 'global';

// Default model config — 引用 shared/constants.ts 常量
const defaultModelConfig: ModelConfig = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  apiKey: '',
  baseUrl: getProviderEndpoint(DEFAULT_PROVIDER),
  temperature: 0.7,
  maxTokens: MODEL_MAX_TOKENS.DEFAULT,
};

export const useAppStore = create<AppState>()((set, get) => ({
  // Initial UI State
  showSettings: false,
  settingsInitialTab: null,
  settingsMemoryFocus: null,
  settingsCapabilityFocus: null,
  composerFocusNonce: 0,
  pendingRoleChatSeed: null,
  pendingProjectGoalChatSeed: null,
  showPromptManager: false,
  showWorkspace: false,
  taskPanelTab: 'monitor',
  showAgentTeamPanel: false,
  selectedSwarmAgentId: null,
  activeAgentId: null,
  activeAgentSessionKey: null,
  showCapturePanel: false, // Capture panel hidden by default
  showDesktopPanel: false,
  showLocalOpsPanel: false,
  showInAppValidation: false,
  activeInternalFeatureId: null,
  localOpsTab: 'browser',
  pendingInAppValidationRequest: null,
  showProjectCollaborationPage: false,
  projectCollaborationPageProjectId: null,
  showProjectSpacePage: false,
  showActivityPanel: false,
  showCapabilityHub: false,
  capabilityHubTab: 'experts',
  showCronCenter: false,
  showTimeCapabilityCenter: false,
  showFileExplorer: false,
  voicePasteStatus: 'idle' as const,
  sidebarCollapsed: false,
  optionalUpdateInfo: null,
  showOptionalUpdateModal: false,

  // 语言默认为中文
  language: defaultLanguage,

  // 云端 UI 字符串（初始为 null，由主进程推送）
  cloudUIStrings: null,

  // 渐进披露默认级别
  disclosureLevel: 'standard',

  // 开发者模式默认关闭
  developerMode: false,

  // Initial Chat State (messages/todos/currentSessionId 已迁移到 sessionStore)
  isProcessing: false,
  processingSessionIds: new Set<string>(),

  // Initial Planning State
  taskPlan: null,
  findings: [],
  errors: [],

  // Initial DAG Visualization State
  showDAGPanel: false,

  // Initial Lab State
  showLab: false,
  devServerLauncherOpen: false,

  showLibraryPanel: false,
  expertDetailRoleId: null,

  // Initial file preview registry
  previewTabs: [],
  activePreviewTabId: null,

  // Initial workbench — empty until the user opens a tab or live task activity appears.
  workbenchTabs: [],
  activeWorkbenchTab: null,
  workbenchBySession: {},
  workbenchSessionKey: null,
  // 默认收起：开一条新会话时右栏无事可做，常驻空态启动器白占三分之一屏
  // （2026-07-27 审美关拍板）。用户展开后本次运行期内保持展开，切会话不重置。
  workbenchCollapsed: true,
  workbenchCollapsedByUser: false,
  taskWorkbenchOpenSource: null,
  taskWorkbenchActivityActive: false,
  taskWorkbenchActivityKeysBySession: {},
  workbenchHighlight: null,

  // Initial Permission Request State
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {}, resolvedPermissionRequests: {},
  sessionTaskProgress: {},
  sessionTaskComplete: {},
  goalRuns: {},

  // Initial Model Config
  modelConfig: defaultModelConfig,

  // Initial Workspace State
  workingDirectory: null,

  // Initial Context Health State
  contextHealth: null,
  contextHealthCollapsed: true, // 默认收起

  // Actions
  setShowSettings: (show) => set(show
    ? { showSettings: true }
    : { ...SECONDARY_PAGES_CLOSED, showSettings: false }),
  setPendingRoleChatSeed: (seed) => set({ pendingRoleChatSeed: seed }),
  setPendingProjectGoalChatSeed: (seed) => set({ pendingProjectGoalChatSeed: seed }),
  setShowPromptManager: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showPromptManager: show }),
  // 落点判定收在 resolveSettingsDeepLink 一处（ADR-049 §收窄），store 只负责应用
  openSettingsTab: (tab) => {
    const noFocus = { settingsMemoryFocus: null, settingsCapabilityFocus: null };
    const target = resolveSettingsDeepLink(tab, installedBundledCapabilityIds());
    if (target.kind === 'cronCenter') {
      set({ ...SECONDARY_PAGES_CLOSED, showCronCenter: true, showSettings: false, ...noFocus });
    } else if (target.kind === 'capabilityHub') {
      get().openCapabilityHub(target.tab);
      set(noFocus);
    } else {
      set({ showSettings: true, settingsInitialTab: target.tab, ...noFocus });
    }
  },
  openMemorySettings: (focus) => set({
    showSettings: true,
    settingsInitialTab: 'memory',
    settingsMemoryFocus: focus
      ? { ...focus, nonce: nextSettingsMemoryFocusNonce() }
      : null,
    settingsCapabilityFocus: null,
  }),
  openCapabilitySettingsTarget: (focus) => {
    get().openCapabilityHub(focus.kind === 'skill' ? 'skills' : 'connectors');
    set({
      settingsMemoryFocus: null,
      settingsCapabilityFocus: { ...focus, nonce: nextSettingsCapabilityFocusNonce() },
    });
  },
  clearSettingsInitialTab: () => set({ settingsInitialTab: null }),
  clearSettingsMemoryFocus: () => set({ settingsMemoryFocus: null }),
  clearSettingsCapabilityFocus: () => set({ settingsCapabilityFocus: null }),
  requestComposerFocus: () => set((state) => ({ composerFocusNonce: state.composerFocusNonce + 1 })),
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setTaskPanelTab: (tab) => set({ taskPanelTab: tab }),
  setShowAgentTeamPanel: (show) => set({ showAgentTeamPanel: show }),
  setSelectedSwarmAgentId: (agentId) => set({ selectedSwarmAgentId: agentId }),
  setActiveAgentId: (agentId) => {
    set({ activeAgentId: agentId });
    const sessionKey = get().activeAgentSessionKey;
    if (!sessionKey) return; // draft：仅内存，会话创建时经 inheritCurrent 落盘
    const map = readActiveAgentSessionMap();
    if (agentId) map[sessionKey] = agentId;
    else delete map[sessionKey];
    writeActiveAgentSessionMap(map);
  },
  bindAgentForSession: (sessionId, agentId) => {
    const map = readActiveAgentSessionMap();
    map[sessionId] = agentId;
    writeActiveAgentSessionMap(map);
    set({ activeAgentId: agentId });
  },
  syncActiveAgentForSession: (sessionId, opts) => {
    dropLegacyActiveAgentKey();
    if (!sessionId) {
      set({ activeAgentSessionKey: null, activeAgentId: null });
      return;
    }
    const map = readActiveAgentSessionMap(sessionId, opts?.metadata);
    if (opts?.inheritCurrent) {
      const draftSelection = get().activeAgentId;
      if (draftSelection && !map[sessionId]) {
        map[sessionId] = draftSelection;
        writeActiveAgentSessionMap(map);
      }
    }
    set({ activeAgentSessionKey: sessionId, activeAgentId: map[sessionId] ?? null });
  },
  clearActiveAgentForSession: (sessionId, opts) => {
    const map = readActiveAgentSessionMap();
    if (sessionId in map) {
      if (opts?.onlyIfAgentId && map[sessionId] !== opts.onlyIfAgentId) return;
      delete map[sessionId];
      writeActiveAgentSessionMap(map);
    }
    if (get().activeAgentSessionKey === sessionId) {
      set({ activeAgentId: null });
    }
  },
  setShowCapturePanel: (show) => set({ showCapturePanel: show }),
  setShowDesktopPanel: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showDesktopPanel: show }),
  setShowLocalOpsPanel: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showLocalOpsPanel: show }),
  setShowInAppValidation: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showInAppValidation: show }),
  setActiveInternalFeature: (id) => set({ ...(id ? SECONDARY_PAGES_CLOSED : {}), activeInternalFeatureId: id }),
  openLocalOpsPanel: (tab) => set({
    ...SECONDARY_PAGES_CLOSED,
    showLocalOpsPanel: true,
    localOpsTab: tab || 'browser',
  }),
  // 旧入口（MCPSettings 连接器卡片、computerUse.open 快捷键）走 shim 进合并页，UI 不再直接引用旧开关。
  setShowComputerUsePanel: (show) => (show ? get().openLocalOpsPanel('desktop') : get().setShowLocalOpsPanel(false)),
  setShowBrowserSurfacePanel: (show) => (show ? get().openLocalOpsPanel('browser') : get().setShowLocalOpsPanel(false)),
  openProjectCollaborationPage: (projectId) => set({
    ...SECONDARY_PAGES_CLOSED,
    showProjectCollaborationPage: true,
    projectCollaborationPageProjectId: projectId?.trim() || null,
  }),
  closeProjectCollaborationPage: () => set({
    showProjectCollaborationPage: false,
    projectCollaborationPageProjectId: null,
  }),
  openProjectSpacePage: () => set({ ...SECONDARY_PAGES_CLOSED, showProjectSpacePage: true }),
  closeProjectSpacePage: () => set({ showProjectSpacePage: false }),
  setPendingInAppValidationRequest: (request) => set({ pendingInAppValidationRequest: request }),
  setShowActivityPanel: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showActivityPanel: show }),
  setShowCapabilityHub: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showCapabilityHub: show }),
  openCapabilityHub: (tab) => set({
    ...SECONDARY_PAGES_CLOSED,
    showCapabilityHub: true,
    showSettings: false,
    capabilityHubTab: tab,
  }),
  closeSecondaryPages: () => set({ ...SECONDARY_PAGES_CLOSED }),
  setShowCronCenter: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showCronCenter: show }),
  setShowTimeCapabilityCenter: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showTimeCapabilityCenter: show }),
  setShowFileExplorer: (show) => {
    const state = get();
    if (show) state.openWorkbenchTab('files');
    else state.closeWorkbenchTab('files');
    set({ showFileExplorer: show });
  },
  setVoicePasteStatus: (status) => set({ voicePasteStatus: status }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setOptionalUpdateInfo: (info) => set({ optionalUpdateInfo: info }),
  setShowOptionalUpdateModal: (show) => set({ showOptionalUpdateModal: show }),
  setLanguage: (language) => set({ language }),
  setCloudUIStrings: (strings) => set({ cloudUIStrings: strings }),
  setDisclosureLevel: (level) => set({ disclosureLevel: level }),
  setDeveloperMode: (enabled) => set({ developerMode: enabled }),


  setIsProcessing: (processing) => set({ isProcessing: processing }),

  // 按会话设置处理状态
  setSessionProcessing: (sessionId, processing) =>
    set((state) => {
      const newSet = new Set(state.processingSessionIds);
      if (processing) {
        newSet.add(sessionId);
      } else {
        newSet.delete(sessionId);
      }
      // 同时更新全局 isProcessing（兼容旧代码）
      // 有任何会话正在处理时，全局也标记为处理中
      return { processingSessionIds: newSet, isProcessing: newSet.size > 0 };
    }),

  // 检查指定会话是否正在处理
  isSessionProcessing: (sessionId) => get().processingSessionIds.has(sessionId),

  setTaskPlan: (plan) => set({ taskPlan: plan }),

  setFindings: (findings) => set({ findings }),

  setErrors: (errors) => set({ errors }),

  setShowDAGPanel: (show) => set({ showDAGPanel: show }),
  setShowLab: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showLab: show }),
  openDevServerLauncher: () => set({ devServerLauncherOpen: true }),
  closeDevServerLauncher: () => set({ devServerLauncherOpen: false }),
  setShowLibraryPanel: (show) => set({ ...(show ? SECONDARY_PAGES_CLOSED : {}), showLibraryPanel: show }),
  openExpertRoleDetail: (roleId) => set({ ...SECONDARY_PAGES_CLOSED, expertDetailRoleId: roleId }),

  openPreview: (filePath, options) => {
    noteSurfaceIntentNavigation('preview', options?.source ?? 'user');
    const activate = options?.activate !== false;
    if (activate && options?.source !== 'auto') useWorkbenchFocusStore.getState().setWorkbenchFocused(true);
    // Resolve relative paths against workingDirectory
    let resolved = filePath;
    if (filePath && !filePath.startsWith('/')) {
      const wd = get().workingDirectory;
      if (wd) resolved = `${wd}/${filePath}`;
    }
    set((state) => {
      const newWorkbenchId: PreviewWorkbenchViewId = `preview:${resolved}`;
      const existing = state.previewTabs.find((t) => t.kind !== 'liveDev' && t.path === resolved);
      if (existing) {
        return {
          ...state,
          activePreviewTabId: activate ? existing.id : state.activePreviewTabId,
          previewTabs: state.previewTabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  ...(options?.deliverableStatus ? { deliverableStatus: options.deliverableStatus } : {}),
                  lastActivatedAt: activate ? nextPreviewTabTick() : t.lastActivatedAt,
                  // 产物可能在上次打开后被修复/重写过；重新打开时若没有未保存的
                  // 编辑（content===savedContent），重置 isLoaded 让加载 effect
                  // 重读磁盘，避免 iframe 一直渲染修复前的旧版本。
                  isLoaded: t.content !== t.savedContent ? t.isLoaded : false,
                  reloadNonce: t.content !== t.savedContent ? t.reloadNonce : (t.reloadNonce ?? 0) + 1,
                }
              : t,
          ),
          workbenchTabs: state.workbenchTabs.includes(newWorkbenchId)
            ? state.workbenchTabs
            : [...state.workbenchTabs, newWorkbenchId],
          activeWorkbenchTab: activate ? newWorkbenchId : state.activeWorkbenchTab,
          workbenchCollapsed: activate ? options?.source === 'auto' && state.workbenchCollapsedByUser : state.workbenchCollapsed,
        };
      }
      const id = `ptab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tab: PreviewTab = {
        id,
        path: resolved,
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: nextPreviewTabTick(),
        isLoaded: false,
        reloadNonce: 0,
        ...(options?.deliverableStatus ? { deliverableStatus: options.deliverableStatus } : {}),
      };
      // LRU eviction when at capacity — liveDev and file tabs now share the
      // same one-tab-one-workbench-view scheme (`preview:${path}`), so eviction
      // no longer needs to branch on kind.
      let carried = state.previewTabs;
      let workbenchCarried = state.workbenchTabs;
      if (carried.length >= MAX_PREVIEW_TABS) {
        const oldest = carried.reduce((a, b) => (a.lastActivatedAt <= b.lastActivatedAt ? a : b));
        carried = carried.filter((t) => t.id !== oldest.id);
        const evictedWorkbenchId: PreviewWorkbenchViewId = `preview:${oldest.path}`;
        workbenchCarried = workbenchCarried.filter((w) => w !== evictedWorkbenchId);
      }
      return {
        ...state,
        previewTabs: [...carried, tab],
        activePreviewTabId: activate ? id : state.activePreviewTabId,
        workbenchTabs: [...workbenchCarried, newWorkbenchId],
        activeWorkbenchTab: activate ? newWorkbenchId : state.activeWorkbenchTab,
        workbenchCollapsed: activate ? options?.source === 'auto' && state.workbenchCollapsedByUser : state.workbenchCollapsed,
      };
    });
  },
  openContentPreview: (input, options) => {
    noteSurfaceIntentNavigation('preview', options?.source ?? 'user');
    set((state) => ({
      ...state,
      ...buildContentPreviewState(state, input, nextPreviewTabTick, MAX_PREVIEW_TABS),
    }));
  },
  openWorkspacePreview: (options) => {
    noteSurfaceIntentNavigation('overview', options?.source ?? 'user');
    set((state) => ({
      ...state,
      workbenchTabs: state.workbenchTabs.includes('overview')
        ? state.workbenchTabs
        : [...state.workbenchTabs, 'overview'],
      activeWorkbenchTab: 'overview',
      // An artifact now owns the shared overview, so task activity ending must
      // not auto-close the artifact section with it.
      taskWorkbenchOpenSource: null,
    }));
  },
  openLivePreview: (devServerUrl, devServerSessionId, options) => {
    // S2 归位（2026-07-31）：liveDev 预览曾借用 'browser' 这个 workbench view id
    // 共享单一 tab-bar 槽位；'browser' 现在是 Agent 浏览器现场（BrowserAgentWindow）
    // 专属 tab，liveDev 改走与文件预览同一套 `preview:${path}` 一对一 scheme。
    noteSurfaceIntentNavigation('preview', options?.source ?? 'user');
    set((state) => {
      const newWorkbenchId: PreviewWorkbenchViewId = `preview:${devServerUrl}`;
      const existing = state.previewTabs.find((t) => t.kind === 'liveDev' && t.path === devServerUrl);
      if (existing) {
        return {
          ...state,
          activePreviewTabId: existing.id,
          previewTabs: state.previewTabs.map((t) =>
            t.id === existing.id
              ? {
                  ...t,
                  lastActivatedAt: nextPreviewTabTick(),
                  // 后续启动同一 URL 时刷新 sessionId（用户重启 dev server 的场景）
                  devServerSessionId: devServerSessionId ?? t.devServerSessionId,
                }
              : t,
          ),
          workbenchTabs: state.workbenchTabs.includes(newWorkbenchId)
            ? state.workbenchTabs
            : [...state.workbenchTabs, newWorkbenchId],
          activeWorkbenchTab: newWorkbenchId,
        };
      }
      const id = `ptab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tab: PreviewTab = {
        id,
        path: devServerUrl,
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: nextPreviewTabTick(),
        isLoaded: true, // live 不需要 readFile 预热
        kind: 'liveDev',
        devServerUrl,
        devServerSessionId,
        selectedElement: null,
      };
      let carried = state.previewTabs;
      let workbenchCarried = state.workbenchTabs;
      if (carried.length >= MAX_PREVIEW_TABS) {
        const oldest = carried.reduce((a, b) => (a.lastActivatedAt <= b.lastActivatedAt ? a : b));
        carried = carried.filter((t) => t.id !== oldest.id);
        const evictedWorkbenchId: PreviewWorkbenchViewId = `preview:${oldest.path}`;
        workbenchCarried = workbenchCarried.filter((w) => w !== evictedWorkbenchId);
      }
      return {
        ...state,
        previewTabs: [...carried, tab],
        activePreviewTabId: id,
        workbenchTabs: workbenchCarried.includes(newWorkbenchId)
          ? workbenchCarried
          : [...workbenchCarried, newWorkbenchId],
        activeWorkbenchTab: newWorkbenchId,
      };
    });
  },

  setSelectedElement: (tabId, element) => set((state) => ({
    previewTabs: state.previewTabs.map((t) => (t.id === tabId ? { ...t, selectedElement: element } : t)),
  })),

  jumpToFileLine: (filePath, line) => {
    // 先打开文件（已打开则激活）。openPreview 会把目标 tab 设为 active，
    // 之后通过 activePreviewTabId 定位写入 jumpToLine / 递增 jumpNonce。
    get().openPreview(filePath);
    const activeId = get().activePreviewTabId;
    if (!activeId) return;
    set((state) => ({
      previewTabs: state.previewTabs.map((t) =>
        t.id === activeId ? { ...t, jumpToLine: line, jumpNonce: (t.jumpNonce ?? 0) + 1 } : t,
      ),
    }));
  },

  closePreview: () => {
    // V2-A: 收掉所有 Code Agent 自起的 dev server 子进程
    const sessions = get().previewTabs.map((t) => t.devServerSessionId).filter(Boolean) as string[];
    sessions.forEach(fireStopDevServer);
    set((state) => ({
      previewTabs: [],
      activePreviewTabId: null,
      workbenchTabs: state.workbenchTabs.filter((w) => !isPreviewWorkbenchView(w)),
      activeWorkbenchTab: isPreviewWorkbenchView(state.activeWorkbenchTab)
        ? (state.workbenchTabs.find((w) => !isPreviewWorkbenchView(w)) ?? null)
        : state.activeWorkbenchTab,
    }));
  },
  closePreviewTab: (id) => {
    set((state) => {
      const closing = state.previewTabs.find((t) => t.id === id);
      // V2-A: 关掉这个 tab 对应的 dev server（如果是 Code Agent 自起的）
      fireStopDevServer(closing?.devServerSessionId);
      const nextTabs = state.previewTabs.filter((t) => t.id !== id);
      // liveDev 与 file 共享同一套一对一 `preview:${path}` scheme（S2 归位），
      // 关闭逻辑不再需要按 kind 分支。
      const closingWorkbenchId: WorkbenchViewId | null = closing ? `preview:${closing.path}` : null;
      const nextWorkbench = closingWorkbenchId
        ? state.workbenchTabs.filter((view) => view !== closingWorkbenchId)
        : state.workbenchTabs;

      if (nextTabs.length === 0) {
        // No previews left. Fall active back to a pinned tab if one survives.
        const fallback = nextWorkbench[0] ?? null;
        const nextActiveWorkbench =
          state.activeWorkbenchTab === closingWorkbenchId
            ? fallback
            : state.activeWorkbenchTab;
        return {
          ...state,
          previewTabs: nextTabs,
          activePreviewTabId: null,
          workbenchTabs: nextWorkbench,
          activeWorkbenchTab: nextActiveWorkbench,
        };
      }

      let nextActiveId = state.activePreviewTabId;
      let nextActiveWorkbench: WorkbenchViewId | null = state.activeWorkbenchTab;
      if (state.activePreviewTabId === id) {
        const survivor = nextTabs.reduce((a, b) =>
          a.lastActivatedAt >= b.lastActivatedAt ? a : b,
        );
        nextActiveId = survivor.id;
        nextActiveWorkbench = `preview:${survivor.path}`;
      }
      return {
        ...state,
        previewTabs: nextTabs,
        activePreviewTabId: nextActiveId,
        workbenchTabs: nextWorkbench,
        activeWorkbenchTab: nextActiveWorkbench,
      };
    });
  },
  setActivePreviewTab: (id) => {
    set((state) => {
      const target = state.previewTabs.find((t) => t.id === id);
      return {
        ...state,
        activePreviewTabId: id,
        previewTabs: state.previewTabs.map((t) =>
          t.id === id ? { ...t, lastActivatedAt: nextPreviewTabTick() } : t,
        ),
        activeWorkbenchTab: target ? `preview:${target.path}` : state.activeWorkbenchTab,
      };
    });
  },
  updatePreviewTabContent: (id, content) => {
    set((state) => ({
      ...state,
      previewTabs: state.previewTabs.map((t) => (t.id === id ? { ...t, content } : t)),
    }));
  },
  updatePreviewTabMode: (id, mode) => {
    set((state) => ({
      ...state,
      previewTabs: state.previewTabs.map((t) => (t.id === id ? { ...t, mode } : t)),
    }));
  },
  markPreviewTabLoaded: (id, savedContent) => {
    set((state) => ({
      ...state,
      previewTabs: state.previewTabs.map((t) =>
        t.id === id ? { ...t, content: savedContent, savedContent, isLoaded: true } : t,
      ),
    }));
  },
  markPreviewTabSaved: (id) => {
    set((state) => ({
      ...state,
      previewTabs: state.previewTabs.map((t) =>
        t.id === id ? { ...t, savedContent: t.content } : t,
      ),
    }));
  },

  ...createWorkbenchActions({
    set,
    get,
    nextPreviewTabTick,
  }),

  setWorkbenchCollapsed: (collapsed) => set({ workbenchCollapsed: collapsed, workbenchCollapsedByUser: collapsed }),

  setWorkbenchHighlight: (highlight) =>
    set({
      workbenchHighlight: highlight
        ? { ...highlight, nonce: Date.now() }
        : null,
    }),

  setPendingPermissionRequest: (request, sessionId = null) => set({
    pendingPermissionRequest: request, pendingPermissionSessionId: request ? sessionId : null,
  }),

  recordPermissionDecision: (request, decision, sessionId = null) => set((state) =>
    buildPermissionDecisionState(state, request, decision, sessionId, GLOBAL_PERMISSION_REQUEST_SESSION_ID)),

  dismissPermissionRequest: (requestId) => set((state) => buildPermissionDismissState(state, requestId)),

  enqueuePermissionRequest: (sessionId, request, options) =>
    set((state) => {
      const existingQueue = state.queuedPermissionRequests[sessionId] || [];
      const nextQueue = options?.front
        ? [request, ...existingQueue]
        : [...existingQueue, request];

      return {
        queuedPermissionRequests: {
          ...state.queuedPermissionRequests,
          [sessionId]: nextQueue,
        },
      };
    }),

  shiftQueuedPermissionRequest: (sessionId) => {
    let nextRequest: PermissionRequest | null = null;

    set((state) => {
      const queue = state.queuedPermissionRequests[sessionId] || [];
      if (queue.length === 0) {
        return state;
      }

      nextRequest = queue[0];
      const remaining = queue.slice(1);
      const nextQueues = { ...state.queuedPermissionRequests };

      if (remaining.length > 0) {
        nextQueues[sessionId] = remaining;
      } else {
        delete nextQueues[sessionId];
      }

      return { queuedPermissionRequests: nextQueues };
    });

    return nextRequest;
  },

  clearPermissionRequestsForSession: (sessionId) =>
    set((state) => {
      const nextQueues = { ...state.queuedPermissionRequests };
      delete nextQueues[sessionId];

      const shouldClearPending = state.pendingPermissionSessionId === sessionId
        || (
          sessionId === GLOBAL_PERMISSION_REQUEST_SESSION_ID
          && state.pendingPermissionRequest !== null
          && state.pendingPermissionSessionId === null
        );

      return {
        queuedPermissionRequests: nextQueues,
        ...(shouldClearPending
          ? {
            pendingPermissionRequest: null,
            pendingPermissionSessionId: null,
          }
          : {}),
      };
    }),

  setSessionTaskProgress: (sessionId, progress) =>
    set((state) => ({
      sessionTaskProgress: {
        ...state.sessionTaskProgress,
        [sessionId]: progress,
      },
    })),

  setSessionTaskComplete: (sessionId, complete) =>
    set((state) => ({
      sessionTaskComplete: {
        ...state.sessionTaskComplete,
        [sessionId]: complete,
      },
    })),

  // ---- /goal 运行态 ----
  startGoalRun: (sessionId, init) =>
    set((state) => ({
      goalRuns: {
        ...state.goalRuns,
        [sessionId]: {
          goal: init.goal,
          startedAt: Date.now(),
          status: 'running',
          turn: 0,
          maxTurns: init.maxTurns ?? 0,
          tokensUsed: 0,
          tokenBudget: init.tokenBudget ?? 0,
          wallClockBudgetMs: init.wallClockBudgetMs,
          gates: [],
        },
      },
    })),

  updateGoalProgress: (sessionId, data) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      if (!prev) return {};
      return {
        goalRuns: {
          ...state.goalRuns,
          [sessionId]: {
            ...prev,
            turn: data.turn ?? prev.turn,
            maxTurns: data.maxTurns ?? prev.maxTurns,
            tokensUsed: data.tokensUsed ?? prev.tokensUsed,
            tokenBudget: data.tokenBudget ?? prev.tokenBudget,
            wallClockBudgetMs: data.wallClockBudgetMs ?? prev.wallClockBudgetMs,
          },
        },
      };
    }),

  recordGoalGate: (sessionId, gate) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      if (!prev) return {};
      return {
        goalRuns: {
          ...state.goalRuns,
          [sessionId]: {
            ...prev,
            lastGate: gate,
            gates: [...(prev.gates ?? []), gate],
          },
        },
      };
    }),

  finishGoalRun: (sessionId, status, reason, degraded) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      if (!prev) return {};
      return {
        goalRuns: {
          ...state.goalRuns,
          [sessionId]: { ...prev, status, reason, finishedAt: Date.now(), ...(degraded ? { degraded } : {}) },
        },
      };
    }),

  setGoalPaused: (sessionId, paused, pauseReason) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      // 仅运行中/已暂停的 goal 可切换；met/aborted 终态不动
      if (!prev || (prev.status !== 'running' && prev.status !== 'paused')) return {};
      return {
        goalRuns: {
          ...state.goalRuns,
          [sessionId]: { ...prev, status: paused ? 'paused' : 'running', reason: paused ? pauseReason : undefined },
        },
      };
    }),

  clearGoalRun: (sessionId) =>
    set((state) => {
      const next = { ...state.goalRuns };
      delete next[sessionId];
      return { goalRuns: next };
    }),

  setModelConfig: (config) => set({ modelConfig: config }),

  // 清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () =>
    set({ taskPlan: null, findings: [], errors: [] }),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setContextHealth: (health) => set({ contextHealth: health }),
  setContextHealthCollapsed: (collapsed) => set({ contextHealthCollapsed: collapsed }),
}));

// E2E/dev 调试钩子：真机测试用 openSettingsTab 打开设置并跳到指定 tab（同 window.__neo* 例）。
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __neoAppStore?: typeof useAppStore }).__neoAppStore = useAppStore;
}
