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
} from '@shared/contract';
import type { ContextHealthState } from '@shared/contract/contextHealth';
import { defaultLanguage, type Language } from '../i18n';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  MODEL_MAX_TOKENS,
  getProviderEndpoint,
} from '@shared/constants';

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

// 云端 UI 字符串类型
type CloudUIStrings = {
  zh: Record<string, string>;
  en: Record<string, string>;
};

// 设置页 Tab 类型
export type SettingsTab = 'general' | 'model' | 'appearance' | 'cache' | 'cloud' | 'mcp' | 'skills' | 'channels' | 'agents' | 'memory' | 'update' | 'products' | 'about';
export type TaskPanelTab = 'monitor' | 'overview' | 'orchestration';

// Preview tab — one per opened file
export interface PreviewTab {
  id: string;
  path: string;
  content: string;      // editor buffer (may differ from saved)
  savedContent: string; // last-known on-disk content
  mode: 'preview' | 'edit';
  lastActivatedAt: number;
  isLoaded: boolean;    // whether readFile has populated savedContent yet
}

interface AppState {
  // UI State
  showSettings: boolean;
  settingsInitialTab: SettingsTab | null; // 打开设置时默认选中的 Tab
  showWorkspace: boolean;
  showTaskPanel: boolean;
  taskPanelTab: TaskPanelTab;
  showAgentTeamPanel: boolean;
  selectedSwarmAgentId: string | null;
  showSkillsPanel: boolean;
  showCapturePanel: boolean;
  showDesktopPanel: boolean;
  showCronCenter: boolean;
  showFileExplorer: boolean;
  voicePasteStatus: 'idle' | 'recording' | 'transcribing' | 'processing';
  sidebarCollapsed: boolean;

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

  // EvalCenter State (评测中心：合并会话评测 + 遥测)
  showEvalCenter: boolean;
  evalCenterTab: 'analysis' | 'telemetry' | 'testResults';
  evalCenterSessionId: string | null;

  // HTML Preview State (multi-tab)
  previewTabs: PreviewTab[];
  activePreviewTabId: string | null;
  showPreviewPanel: boolean;

  // Permission Request State
  pendingPermissionRequest: PermissionRequest | null;
  pendingPermissionSessionId: string | null;
  queuedPermissionRequests: Record<string, PermissionRequest[]>;
  sessionTaskProgress: Record<string, TaskProgressData | null | undefined>;
  sessionTaskComplete: Record<string, TaskCompleteData | null | undefined>;

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
  clearSettingsInitialTab: () => void; // 清除初始 Tab（设置页使用后调用）
  setShowWorkspace: (show: boolean) => void;
  setShowTaskPanel: (show: boolean) => void;
  setTaskPanelTab: (tab: TaskPanelTab) => void;
  setShowAgentTeamPanel: (show: boolean) => void;
  setSelectedSwarmAgentId: (agentId: string | null) => void;
  setShowSkillsPanel: (show: boolean) => void;
  setShowCapturePanel: (show: boolean) => void;
  setShowDesktopPanel: (show: boolean) => void;
  setShowCronCenter: (show: boolean) => void;
  setShowFileExplorer: (show: boolean) => void;
  setVoicePasteStatus: (status: 'idle' | 'recording' | 'transcribing' | 'processing') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
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
  setShowEvalCenter: (show: boolean, tab?: 'analysis' | 'telemetry' | 'testResults', sessionId?: string) => void;
  setShowPreviewPanel: (show: boolean) => void;
  openPreview: (filePath: string) => void;
  closePreview: () => void;
  closePreviewTab: (id: string) => void;
  setActivePreviewTab: (id: string) => void;
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
  setModelConfig: (config: ModelConfig) => void;
  // clearChat 简化：只清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () => void;
  setWorkingDirectory: (dir: string | null) => void;
  setContextHealth: (health: ContextHealthState | null) => void;
  setContextHealthCollapsed: (collapsed: boolean) => void;
  setCacheStats: (stats: { promptCacheHits: number; promptCacheMisses: number; totalCachedTokens: number } | null) => void;
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

export const useAppStore = create<AppState>((set, get) => ({
  // Initial UI State
  showSettings: false,
  settingsInitialTab: null,
  showWorkspace: false,
  showTaskPanel: true, // Task panel shown by default
  taskPanelTab: 'monitor',
  showAgentTeamPanel: false,
  selectedSwarmAgentId: null,
  showSkillsPanel: false, // Skills panel hidden by default
  showCapturePanel: false, // Capture panel hidden by default
  showDesktopPanel: false,
  showCronCenter: false,
  showFileExplorer: false,
  voicePasteStatus: 'idle' as const,
  sidebarCollapsed: false,

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

  // Initial EvalCenter State
  showEvalCenter: false,
  evalCenterTab: 'analysis' as const,
  evalCenterSessionId: null,

  // Initial HTML Preview State
  previewTabs: [],
  activePreviewTabId: null,
  showPreviewPanel: false,

  // Initial Permission Request State
  pendingPermissionRequest: null,
  pendingPermissionSessionId: null,
  queuedPermissionRequests: {},
  sessionTaskProgress: {},
  sessionTaskComplete: {},

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
  openSettingsTab: (tab) => set({ showSettings: true, settingsInitialTab: tab }),
  clearSettingsInitialTab: () => set({ settingsInitialTab: null }),
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setTaskPanelTab: (tab) => set({ taskPanelTab: tab }),
  setShowAgentTeamPanel: (show) => set({ showAgentTeamPanel: show }),
  setSelectedSwarmAgentId: (agentId) => set({ selectedSwarmAgentId: agentId }),
  setShowSkillsPanel: (show) => set({ showSkillsPanel: show }),
  setShowCapturePanel: (show) => set({ showCapturePanel: show }),
  setShowDesktopPanel: (show) => set({ showDesktopPanel: show }),
  setShowCronCenter: (show) => set({ showCronCenter: show }),
  setShowFileExplorer: (show) => set({ showFileExplorer: show }),
  setVoicePasteStatus: (status) => set({ voicePasteStatus: status }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
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
  setShowEvalCenter: (show, tab, sessionId) => set({
    showEvalCenter: show,
    ...(tab ? { evalCenterTab: tab } : {}),
    ...(sessionId !== undefined ? { evalCenterSessionId: sessionId } : {}),
    ...(!show ? { evalCenterSessionId: null } : {}),
  }),

  setShowPreviewPanel: (show) => set({ showPreviewPanel: show }),
  openPreview: (filePath) => {
    // Resolve relative paths against workingDirectory
    let resolved = filePath;
    if (filePath && !filePath.startsWith('/')) {
      const wd = get().workingDirectory;
      if (wd) resolved = `${wd}/${filePath}`;
    }
    set((state) => {
      const existing = state.previewTabs.find((t) => t.path === resolved);
      if (existing) {
        return {
          ...state,
          activePreviewTabId: existing.id,
          showPreviewPanel: true,
          previewTabs: state.previewTabs.map((t) =>
            t.id === existing.id ? { ...t, lastActivatedAt: Date.now() } : t,
          ),
        };
      }
      const id = `ptab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tab: PreviewTab = {
        id,
        path: resolved,
        content: '',
        savedContent: '',
        mode: 'preview',
        lastActivatedAt: Date.now(),
        isLoaded: false,
      };
      return {
        ...state,
        previewTabs: [...state.previewTabs, tab],
        activePreviewTabId: id,
        showPreviewPanel: true,
      };
    });
  },
  closePreview: () => set({ previewTabs: [], activePreviewTabId: null, showPreviewPanel: false }),
  closePreviewTab: (id) => {
    set((state) => {
      const nextTabs = state.previewTabs.filter((t) => t.id !== id);
      if (nextTabs.length === 0) {
        return { ...state, previewTabs: nextTabs, activePreviewTabId: null, showPreviewPanel: false };
      }
      let nextActiveId = state.activePreviewTabId;
      if (state.activePreviewTabId === id) {
        // Pick the most-recently-activated remaining tab
        nextActiveId = nextTabs.reduce((a, b) => (a.lastActivatedAt >= b.lastActivatedAt ? a : b)).id;
      }
      return { ...state, previewTabs: nextTabs, activePreviewTabId: nextActiveId };
    });
  },
  setActivePreviewTab: (id) => {
    set((state) => ({
      ...state,
      activePreviewTabId: id,
      previewTabs: state.previewTabs.map((t) =>
        t.id === id ? { ...t, lastActivatedAt: Date.now() } : t,
      ),
    }));
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

  setModelConfig: (config) => set({ modelConfig: config }),

  // 清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () =>
    set({ taskPlan: null, findings: [], errors: [] }),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setContextHealth: (health) => set({ contextHealth: health }),
  setContextHealthCollapsed: (collapsed) => set({ contextHealthCollapsed: collapsed }),
  setCacheStats: (stats) => set({ cacheStats: stats }),
}));
