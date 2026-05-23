// ============================================================================
// App Store - Global Application State
// ============================================================================

import { create } from 'zustand';
import type {
  ModelConfig,
  TaskPlan,
  Finding,
  ErrorRecord,
  PermissionRequest,
  TaskProgressData,
  TaskCompleteData,
  UpdateInfo,
} from '@shared/contract';
import type { ContextHealthState } from '@shared/contract/contextHealth';
import { defaultLanguage, type Language } from '../i18n';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  MODEL_MAX_TOKENS,
  getProviderEndpoint,
} from '@shared/constants';
import { IPC_DOMAINS } from '@shared/ipc/domains';
import { invokeDomain } from '../services/ipcService';
import type { SettingsTab } from '../utils/settingsTabs';

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

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

// 云端 UI 字符串类型
type CloudUIStrings = {
  zh: Record<string, string>;
  en: Record<string, string>;
};

// 设置页 Tab 类型
export type { SettingsTab } from '../utils/settingsTabs';
export type TaskPanelTab = 'monitor' | 'orchestration';

// Preview tab — one per opened file (kind === 'file') or live dev server (kind === 'liveDev')
export interface PreviewTab {
  id: string;
  path: string;
  content: string;      // editor buffer (may differ from saved)
  savedContent: string; // last-known on-disk content
  mode: 'preview' | 'edit';
  lastActivatedAt: number;
  isLoaded: boolean;    // whether readFile has populated savedContent yet
  // Live Preview (D3+) — 存在时覆盖文件语义
  kind?: 'file' | 'liveDev';
  devServerUrl?: string;
  /** V2-A: Code Agent 自起的 dev server session id；用户外部起的 dev server 留空 */
  devServerSessionId?: string;
  selectedElement?: LivePreviewSelectedElement | null;
  // D6: 外部驱动的编辑器跳转（file tab 使用）
  jumpToLine?: number;
  jumpNonce?: number;
}

// Bridge 回传的元素信息（保持与 shared/livePreview/protocol.ts 中 SelectedElementInfo 同形）
export interface LivePreviewSelectedElement {
  /** 绝对路径（resolveSourceLocation 规范化后），composer 注入 envelope 用这个 */
  file: string;
  /** 原始相对路径（bridge 里 data-code-agent-source 存的形），用于 HMR vg:restore-selection 反查 DOM */
  relativeFile: string;
  line: number;
  column: number;
  tag: string;
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  componentName?: string;
  /** V2-B (protocol 0.3.0) — DOM class 属性当前值，TweakPanel 解析展示 */
  className?: string;
  /** V2-B (protocol 0.3.0) — getComputedStyle 子集，TweakPanel 渲染当前值 */
  computedStyle?: import('@shared/livePreview/protocol').ComputedStyleSnapshot;
}

// Max open preview tabs. When exceeded, the least-recently-activated tab is evicted.
export const MAX_PREVIEW_TABS = 8;

// Monotonic tick for tab lastActivatedAt — avoids Date.now() collisions
// when several activations fire in the same millisecond.
let _previewTabTick = 0;
const nextPreviewTabTick = () => ++_previewTabTick;
let _settingsMemoryFocusTick = 0;
const nextSettingsMemoryFocusNonce = () => ++_settingsMemoryFocusTick;

// Unified right-workbench tab identity.
// Preview tabs embed their file path after the 'preview:' prefix.
// 'context' tab — ContextPanel 容器，挂 ContextHealthPanel 并展示 bySource 二级拆分
export type WorkbenchTabId = 'task' | 'skills' | 'files' | 'workspace-preview' | 'context' | 'master-tasks' | `preview:${string}`;

// 跨 panel 跳转目标
// kind 决定跳到哪个 tab 并 highlight；name 是被高亮的项标识
export interface WorkbenchHighlight {
  kind: 'skill' | 'mcp' | 'subagent';
  name: string;
  nonce: number;
}

export interface SettingsMemoryFocus {
  filename?: string;
  query?: string;
  nonce: number;
}

const PREVIEW_PREFIX = 'preview:';
const isPreviewWorkbenchId = (id: WorkbenchTabId): id is `preview:${string}` =>
  id.startsWith(PREVIEW_PREFIX);
const previewPathOf = (id: `preview:${string}`): string => id.slice(PREVIEW_PREFIX.length);

/** /goal 自治模式的前端运行态（per-session，由 SSE goal_* 事件驱动）。 */
export interface GoalRunState {
  /** 目标文本（"开启目标：xxx" 展示用） */
  goal: string;
  /** 开始时间戳（计时器据此算已运行时长） */
  startedAt: number;
  /** 运行态：running 进行中 / met 达成 / aborted 兜底中止 */
  status: 'running' | 'met' | 'aborted';
  /** 当前第几轮 */
  turn: number;
  /** 轮次上限 */
  maxTurns: number;
  /** 已用 token */
  tokensUsed: number;
  /** token 预算 */
  tokenBudget: number;
  /** 中止原因（status=aborted 时） */
  abortReason?: string;
  /** 结束时间戳（met/aborted 后用于停表 + 展示总耗时） */
  finishedAt?: number;
  /** 最近一次闸判定（UI 可显示"验证中/评审中"反馈） */
  lastGate?: { gate: number; pass: boolean; reason?: string };
}

interface AppState {
  // UI State
  showSettings: boolean;
  settingsInitialTab: SettingsTab | null; // 打开设置时默认选中的 Tab
  settingsMemoryFocus: SettingsMemoryFocus | null;
  showPromptManager: boolean;
  showWorkspace: boolean;
  taskPanelTab: TaskPanelTab;
  showAgentTeamPanel: boolean;
  selectedSwarmAgentId: string | null;
  /** 用户在 StatusBar 选中的默认 agent id（来自 agentRegistryStore），持久化到 localStorage。 */
  activeAgentId: string | null;
  showCapturePanel: boolean;
  showBrowserSurfacePanel: boolean;
  showDesktopPanel: boolean;
  showComputerUsePanel: boolean;
  showInAppValidationPanel: boolean;
  pendingInAppValidationRequest: import('@shared/contract/browserInteraction').InAppValidationRequest | null;
  showActivityPanel: boolean;
  showCronCenter: boolean;
  showTimeCapabilityCenter: boolean;
  showFileExplorer: boolean;
  voicePasteStatus: 'idle' | 'recording' | 'transcribing' | 'processing';
  sidebarCollapsed: boolean;
  optionalUpdateInfo: UpdateInfo | null;

  // 语言设置 - Language
  language: Language;

  // 云端 UI 字符串（热更新）
  cloudUIStrings: CloudUIStrings | null;

  // 渐进披露 - Progressive Disclosure
  disclosureLevel: DisclosureLevel;


  // Chat State (messages/todos/currentSessionId 已迁移到 sessionStore)
  isProcessing: boolean;
  // 按会话追踪处理状态（支持多会话并发）
  processingSessionIds: Set<string>;

  // Planning State (for Gen 3+ persistent planning)
  taskPlan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];
  showPlanningPanel: boolean;

  // DAG Visualization State (任务执行图可视化)
  showDAGPanel: boolean;

  // Lab State (实验室)
  showLab: boolean;

  // V2-A: DevServerLauncher 模态可见性。true 时 App 渲染 <DevServerLauncher />
  devServerLauncherOpen: boolean;

  showKnowledgeMemoryPanel: boolean;

  // File preview tab registry — one entry per opened file (content, dirty state, LRU).
  previewTabs: PreviewTab[];
  activePreviewTabId: string | null;
  selectedWorkspacePreviewId: string | null;

  // Unified right workbench — tab order & active view across Task/Skills/Preview.
  workbenchTabs: WorkbenchTabId[];
  activeWorkbenchTab: WorkbenchTabId | null;

  // 跨 panel 跳转高亮：ContextPanel → SkillsPanel 点击 source 时设置
  // nonce 用于同一目标重复触发时强制 effect 重跑
  workbenchHighlight: WorkbenchHighlight | null;

  // Permission Request State
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null;
  queuedPermissionRequests: Record<string, PermissionRequest[]>;
  sessionTaskProgress: Record<string, TaskProgressData | null | undefined>;
  sessionTaskComplete: Record<string, TaskCompleteData | null | undefined>;

  // /goal 自治模式运行态（per-session，SSE goal_* 事件驱动；状态条/生命周期消息读它）
  goalRuns: Record<string, GoalRunState | undefined>;

  // Model Config
  modelConfig: ModelConfig;

  // Workspace State
  workingDirectory: string | null;

  // Context Health State (上下文健康度)
  contextHealth: ContextHealthState | null;
  contextHealthCollapsed: boolean;

  // Cache Stats (缓存统计)
  cacheStats: {
    promptCacheHits: number;
    promptCacheMisses: number;
    totalCachedTokens: number;
  } | null;

  // Actions
  setShowSettings: (show: boolean) => void;
  openSettingsTab: (tab: SettingsTab) => void; // 打开设置并跳转到指定 Tab
  openMemorySettings: (focus?: Omit<SettingsMemoryFocus, 'nonce'>) => void;
  clearSettingsInitialTab: () => void; // 清除初始 Tab（设置页使用后调用）
  clearSettingsMemoryFocus: () => void;
  setShowPromptManager: (show: boolean) => void;
  setShowWorkspace: (show: boolean) => void;
  setTaskPanelTab: (tab: TaskPanelTab) => void;
  setShowAgentTeamPanel: (show: boolean) => void;
  setSelectedSwarmAgentId: (agentId: string | null) => void;
  /** 设置默认 agent；传 null 表示回到 builtin 'coder'（spawn 端处理）。 */
  setActiveAgentId: (agentId: string | null) => void;
  setShowCapturePanel: (show: boolean) => void;
  setShowBrowserSurfacePanel: (show: boolean) => void;
  setShowDesktopPanel: (show: boolean) => void;
  setShowComputerUsePanel: (show: boolean) => void;
  setShowInAppValidationPanel: (show: boolean) => void;
  setPendingInAppValidationRequest: (
    request: import('@shared/contract/browserInteraction').InAppValidationRequest | null,
  ) => void;
  setShowActivityPanel: (show: boolean) => void;
  setShowCronCenter: (show: boolean) => void;
  setShowTimeCapabilityCenter: (show: boolean) => void;
  setShowFileExplorer: (show: boolean) => void;
  setVoicePasteStatus: (status: 'idle' | 'recording' | 'transcribing' | 'processing') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setOptionalUpdateInfo: (info: UpdateInfo | null) => void;
  setLanguage: (language: Language) => void;
  setCloudUIStrings: (strings: CloudUIStrings | null) => void;
  setDisclosureLevel: (level: DisclosureLevel) => void;
  setIsProcessing: (processing: boolean) => void;
  // 按会话设置处理状态
  setSessionProcessing: (sessionId: string, processing: boolean) => void;
  // 检查指定会话是否正在处理
  isSessionProcessing: (sessionId: string) => boolean;
  setTaskPlan: (plan: TaskPlan | null) => void;
  setFindings: (findings: Finding[]) => void;
  setErrors: (errors: ErrorRecord[]) => void;
  setShowPlanningPanel: (show: boolean) => void;
  setShowDAGPanel: (show: boolean) => void;
  toggleDAGPanel: () => void;
  setShowLab: (show: boolean) => void;
  setShowKnowledgeMemoryPanel: (show: boolean) => void;
  openPreview: (filePath: string) => void;
  openWorkspacePreview: (itemId?: string | null) => void;
  setSelectedWorkspacePreviewId: (itemId: string | null) => void;
  openLivePreview: (devServerUrl: string, devServerSessionId?: string) => void;
  /** V2-A: 打开/关闭 dev server launcher 模态 */
  openDevServerLauncher: () => void;
  closeDevServerLauncher: () => void;
  setSelectedElement: (tabId: string, element: LivePreviewSelectedElement | null) => void;
  jumpToFileLine: (filePath: string, line: number) => void;
  closePreview: () => void;
  closePreviewTab: (id: string) => void;
  setActivePreviewTab: (id: string) => void;

  // Unified workbench actions.
  openWorkbenchTab: (id: WorkbenchTabId) => void;
  closeWorkbenchTab: (id: WorkbenchTabId) => void;
  setActiveWorkbenchTab: (id: WorkbenchTabId | null) => void;
  setWorkbenchHighlight: (highlight: Omit<WorkbenchHighlight, 'nonce'> | null) => void;
  updatePreviewTabContent: (id: string, content: string) => void;
  updatePreviewTabMode: (id: string, mode: 'preview' | 'edit') => void;
  markPreviewTabLoaded: (id: string, savedContent: string) => void;
  markPreviewTabSaved: (id: string) => void;
  setPendingPermissionRequest: (request: PermissionRequest | null, sessionId?: string | null) => void;
  enqueuePermissionRequest: (
    sessionId: string,
    request: PermissionRequest,
    options?: { front?: boolean }
  ) => void;
  shiftQueuedPermissionRequest: (sessionId: string) => PermissionRequest | null;
  setSessionTaskProgress: (sessionId: string, progress: TaskProgressData | null) => void;
  setSessionTaskComplete: (sessionId: string, complete: TaskCompleteData | null) => void;

  // /goal 运行态 actions
  startGoalRun: (sessionId: string, init: { goal: string; maxTurns?: number; tokenBudget?: number }) => void;
  updateGoalProgress: (sessionId: string, data: { turn?: number; maxTurns?: number; tokensUsed?: number; tokenBudget?: number }) => void;
  recordGoalGate: (sessionId: string, gate: { gate: number; pass: boolean; reason?: string }) => void;
  finishGoalRun: (sessionId: string, status: 'met' | 'aborted', abortReason?: string) => void;
  clearGoalRun: (sessionId: string) => void;
  setModelConfig: (config: ModelConfig) => void;
  // clearChat 简化：只清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () => void;
  setWorkingDirectory: (dir: string | null) => void;
  setContextHealth: (health: ContextHealthState | null) => void;
  setContextHealthCollapsed: (collapsed: boolean) => void;
  setCacheStats: (stats: { promptCacheHits: number; promptCacheMisses: number; totalCachedTokens: number } | null) => void;
}

// localStorage key for activeAgentId 持久化
const ACTIVE_AGENT_STORAGE_KEY = 'app:activeAgentId';

function loadInitialActiveAgentId(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

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
  showPromptManager: false,
  showWorkspace: false,
  taskPanelTab: 'monitor',
  showAgentTeamPanel: false,
  selectedSwarmAgentId: null,
  activeAgentId: loadInitialActiveAgentId(),
  showCapturePanel: false, // Capture panel hidden by default
  showBrowserSurfacePanel: false,
  showDesktopPanel: false,
  showComputerUsePanel: false,
  showInAppValidationPanel: false,
  pendingInAppValidationRequest: null,
  showActivityPanel: false,
  showCronCenter: false,
  showTimeCapabilityCenter: false,
  showFileExplorer: false,
  voicePasteStatus: 'idle' as const,
  sidebarCollapsed: false,
  optionalUpdateInfo: null,

  // 语言默认为中文
  language: defaultLanguage,

  // 云端 UI 字符串（初始为 null，由主进程推送）
  cloudUIStrings: null,

  // 渐进披露默认级别
  disclosureLevel: 'standard',

  // Initial Chat State (messages/todos/currentSessionId 已迁移到 sessionStore)
  isProcessing: false,
  processingSessionIds: new Set<string>(),

  // Initial Planning State
  taskPlan: null,
  findings: [],
  errors: [],
  showPlanningPanel: false,

  // Initial DAG Visualization State
  showDAGPanel: false,

  // Initial Lab State
  showLab: false,
  devServerLauncherOpen: false,

  showKnowledgeMemoryPanel: false,

  // Initial file preview registry
  previewTabs: [],
  activePreviewTabId: null,
  selectedWorkspacePreviewId: null,

  // Initial workbench — Task pinned and active by default.
  workbenchTabs: ['task'],
  activeWorkbenchTab: 'task',
  workbenchHighlight: null,

  // Initial Permission Request State
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
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

  // Initial Cache Stats
  cacheStats: null,

  // Actions
  setShowSettings: (show) => set({ showSettings: show }),
  setShowPromptManager: (show) => set({ showPromptManager: show }),
  openSettingsTab: (tab) => set({ showSettings: true, settingsInitialTab: tab, settingsMemoryFocus: null }),
  openMemorySettings: (focus) => set({
    showSettings: true,
    settingsInitialTab: 'memory',
    settingsMemoryFocus: focus
      ? { ...focus, nonce: nextSettingsMemoryFocusNonce() }
      : null,
  }),
  clearSettingsInitialTab: () => set({ settingsInitialTab: null }),
  clearSettingsMemoryFocus: () => set({ settingsMemoryFocus: null }),
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setTaskPanelTab: (tab) => set({ taskPanelTab: tab }),
  setShowAgentTeamPanel: (show) => set({ showAgentTeamPanel: show }),
  setSelectedSwarmAgentId: (agentId) => set({ selectedSwarmAgentId: agentId }),
  setActiveAgentId: (agentId) => {
    set({ activeAgentId: agentId });
    try {
      if (typeof localStorage !== 'undefined') {
        if (agentId) localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, agentId);
        else localStorage.removeItem(ACTIVE_AGENT_STORAGE_KEY);
      }
    } catch {
      // localStorage 在隐私模式下可能不可用——降级为纯内存状态
    }
  },
  setShowCapturePanel: (show) => set({ showCapturePanel: show }),
  setShowBrowserSurfacePanel: (show) => set({ showBrowserSurfacePanel: show }),
  setShowDesktopPanel: (show) => set({ showDesktopPanel: show }),
  setShowComputerUsePanel: (show) => set({
    showComputerUsePanel: show,
    ...(show ? { showKnowledgeMemoryPanel: false, showInAppValidationPanel: false } : {}),
  }),
  setShowInAppValidationPanel: (show) => set({
    showInAppValidationPanel: show,
    ...(show ? { showKnowledgeMemoryPanel: false, showComputerUsePanel: false } : {}),
  }),
  setPendingInAppValidationRequest: (request) => set({ pendingInAppValidationRequest: request }),
  setShowActivityPanel: (show) => set({ showActivityPanel: show }),
  setShowCronCenter: (show) => set({ showCronCenter: show }),
  setShowTimeCapabilityCenter: (show) => set({ showTimeCapabilityCenter: show }),
  setShowFileExplorer: (show) => {
    const state = get();
    if (show) state.openWorkbenchTab('files');
    else state.closeWorkbenchTab('files');
    set({ showFileExplorer: show });
  },
  setVoicePasteStatus: (status) => set({ voicePasteStatus: status }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setOptionalUpdateInfo: (info) => set({ optionalUpdateInfo: info }),
  setLanguage: (language) => set({ language }),
  setCloudUIStrings: (strings) => set({ cloudUIStrings: strings }),
  setDisclosureLevel: (level) => set({ disclosureLevel: level }),


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

  setShowPlanningPanel: (show) => set({ showPlanningPanel: show }),

  setShowDAGPanel: (show) => set({ showDAGPanel: show }),
  toggleDAGPanel: () => set((state) => ({ showDAGPanel: !state.showDAGPanel })),
  setShowLab: (show) => set({ showLab: show }),
  openDevServerLauncher: () => set({ devServerLauncherOpen: true }),
  closeDevServerLauncher: () => set({ devServerLauncherOpen: false }),
  setShowKnowledgeMemoryPanel: (show) => set({
    showKnowledgeMemoryPanel: show,
    ...(show ? { showComputerUsePanel: false } : {}),
  }),

  openPreview: (filePath) => {
    // Resolve relative paths against workingDirectory
    let resolved = filePath;
    if (filePath && !filePath.startsWith('/')) {
      const wd = get().workingDirectory;
      if (wd) resolved = `${wd}/${filePath}`;
    }
    set((state) => {
      const newWorkbenchId: WorkbenchTabId = `preview:${resolved}`;
      const existing = state.previewTabs.find((t) => t.path === resolved);
      if (existing) {
        return {
          ...state,
          activePreviewTabId: existing.id,
          previewTabs: state.previewTabs.map((t) =>
            t.id === existing.id ? { ...t, lastActivatedAt: nextPreviewTabTick() } : t,
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
        path: resolved,
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: nextPreviewTabTick(),
        isLoaded: false,
      };
      // LRU eviction when at capacity
      let carried = state.previewTabs;
      let workbenchCarried = state.workbenchTabs;
      if (carried.length >= MAX_PREVIEW_TABS) {
        const oldest = carried.reduce((a, b) => (a.lastActivatedAt <= b.lastActivatedAt ? a : b));
        carried = carried.filter((t) => t.id !== oldest.id);
        const evictedWorkbenchId: WorkbenchTabId = `preview:${oldest.path}`;
        workbenchCarried = workbenchCarried.filter((w) => w !== evictedWorkbenchId);
      }
      return {
        ...state,
        previewTabs: [...carried, tab],
        activePreviewTabId: id,
        workbenchTabs: [...workbenchCarried, newWorkbenchId],
        activeWorkbenchTab: newWorkbenchId,
      };
    });
  },
  openWorkspacePreview: (itemId = null) => {
    set((state) => ({
      ...state,
      selectedWorkspacePreviewId: itemId ?? state.selectedWorkspacePreviewId,
      workbenchTabs: state.workbenchTabs.includes('workspace-preview')
        ? state.workbenchTabs
        : [...state.workbenchTabs, 'workspace-preview'],
      activeWorkbenchTab: 'workspace-preview',
    }));
  },
  setSelectedWorkspacePreviewId: (itemId) => set({ selectedWorkspacePreviewId: itemId }),
  openLivePreview: (devServerUrl, devServerSessionId) => {
    // 以 URL 作为唯一 key，沿用 preview: 前缀的 WorkbenchTabId 机制
    set((state) => {
      const newWorkbenchId: WorkbenchTabId = `preview:${devServerUrl}`;
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
        const evictedWorkbenchId: WorkbenchTabId = `preview:${oldest.path}`;
        workbenchCarried = workbenchCarried.filter((w) => w !== evictedWorkbenchId);
      }
      return {
        ...state,
        previewTabs: [...carried, tab],
        activePreviewTabId: id,
        workbenchTabs: [...workbenchCarried, newWorkbenchId],
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
      workbenchTabs: state.workbenchTabs.filter((w) => !isPreviewWorkbenchId(w)),
      activeWorkbenchTab: isPreviewWorkbenchId(state.activeWorkbenchTab ?? 'task')
        ? (state.workbenchTabs.find((w) => !isPreviewWorkbenchId(w)) ?? null)
        : state.activeWorkbenchTab,
    }));
  },
  closePreviewTab: (id) => {
    set((state) => {
      const closing = state.previewTabs.find((t) => t.id === id);
      // V2-A: 关掉这个 tab 对应的 dev server（如果是 Code Agent 自起的）
      fireStopDevServer(closing?.devServerSessionId);
      const closingWorkbenchId: WorkbenchTabId | null = closing
        ? `preview:${closing.path}`
        : null;
      const nextTabs = state.previewTabs.filter((t) => t.id !== id);
      const nextWorkbench = closingWorkbenchId
        ? state.workbenchTabs.filter((w) => w !== closingWorkbenchId)
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
      let nextActiveWorkbench: WorkbenchTabId | null = state.activeWorkbenchTab;
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
        activeWorkbenchTab: target ? (`preview:${target.path}` as WorkbenchTabId) : state.activeWorkbenchTab,
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

  openWorkbenchTab: (id) => {
    set((state) => {
      if (state.workbenchTabs.includes(id)) {
        return { ...state, activeWorkbenchTab: id };
      }
      return {
        ...state,
        workbenchTabs: [...state.workbenchTabs, id],
        activeWorkbenchTab: id,
      };
    });
  },
  closeWorkbenchTab: (id) => {
    // A preview workbench tab is a view onto a file-backed PreviewTab. Closing
    // it should also evict that PreviewTab so content/dirty state does not
    // linger invisibly; delegate to closePreviewTab, which already handles the
    // workbench mirror + activePreviewTabId fallback.
    if (isPreviewWorkbenchId(id)) {
      const path = previewPathOf(id);
      const match = get().previewTabs.find((t) => t.path === path);
      if (match) {
        get().closePreviewTab(match.id);
        return;
      }
      // No backing previewTab (shouldn't normally happen); fall through to
      // the generic workbench cleanup so we at least remove the stale entry.
    }
    set((state) => {
      const nextTabs = state.workbenchTabs.filter((t) => t !== id);
      let nextActive: WorkbenchTabId | null = state.activeWorkbenchTab;
      if (state.activeWorkbenchTab === id) {
        if (nextTabs.length === 0) {
          nextActive = null;
        } else {
          // Prefer the most-recently-activated preview among remaining; else first pinned.
          const remainingPreviews = nextTabs.filter(isPreviewWorkbenchId);
          if (remainingPreviews.length > 0) {
            const byPath = new Map(state.previewTabs.map((pt) => [pt.path, pt]));
            const survivor = remainingPreviews
              .map((wid) => byPath.get(previewPathOf(wid)))
              .filter((t): t is PreviewTab => !!t)
              .reduce<PreviewTab | null>(
                (best, t) => (!best || t.lastActivatedAt > best.lastActivatedAt ? t : best),
                null,
              );
            nextActive = survivor ? (`preview:${survivor.path}` as WorkbenchTabId) : nextTabs[0];
          } else {
            nextActive = nextTabs[0];
          }
        }
      }
      return { ...state, workbenchTabs: nextTabs, activeWorkbenchTab: nextActive };
    });
  },
  setActiveWorkbenchTab: (id) => set({ activeWorkbenchTab: id }),

  setWorkbenchHighlight: (highlight) =>
    set({
      workbenchHighlight: highlight
        ? { ...highlight, nonce: Date.now() }
        : null,
    }),

  setPendingPermissionRequest: (request, sessionId = null) =>
    set({
      pendingPermissionRequest: request,
      pendingPermissionSessionId: request ? sessionId : null,
    }),

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
          },
        },
      };
    }),

  recordGoalGate: (sessionId, gate) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      if (!prev) return {};
      return {
        goalRuns: { ...state.goalRuns, [sessionId]: { ...prev, lastGate: gate } },
      };
    }),

  finishGoalRun: (sessionId, status, abortReason) =>
    set((state) => {
      const prev = state.goalRuns[sessionId];
      if (!prev) return {};
      return {
        goalRuns: {
          ...state.goalRuns,
          [sessionId]: { ...prev, status, abortReason, finishedAt: Date.now() },
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
  setCacheStats: (stats) => set({ cacheStats: stats }),
}));
