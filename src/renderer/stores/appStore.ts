// ============================================================================
// App Store - Global Application State
// ============================================================================

import { create } from 'zustand';
import type {
  Generation,
  ModelConfig,
  TaskPlan,
  Finding,
  ErrorRecord,
  PermissionRequest,
} from '@shared/types';
import type { ContextHealthState } from '@shared/types/contextHealth';
import { defaultLanguage, type Language } from '../i18n';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, MODEL_API_ENDPOINTS } from '@shared/constants';

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

// 云端 UI 字符串类型
type CloudUIStrings = {
  zh: Record<string, string>;
  en: Record<string, string>;
};

// 设置页 Tab 类型
export type SettingsTab = 'general' | 'model' | 'appearance' | 'cache' | 'cloud' | 'mcp' | 'skills' | 'channels' | 'agents' | 'memory' | 'update' | 'about';

interface AppState {
  // UI State
  showSettings: boolean;
  settingsInitialTab: SettingsTab | null; // 打开设置时默认选中的 Tab
  showWorkspace: boolean;
  showTaskPanel: boolean;
  showSkillsPanel: boolean;
  sidebarCollapsed: boolean;

  // 语言设置 - Language
  language: Language;

  // 云端 UI 字符串（热更新）
  cloudUIStrings: CloudUIStrings | null;

  // 渐进披露 - Progressive Disclosure
  disclosureLevel: DisclosureLevel;

  // Generation State
  currentGeneration: Generation;
  availableGenerations: Generation[];

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

  // Evaluation State (会话评测)
  showEvaluation: boolean;

  // Telemetry State (遥测面板)
  showTelemetry: boolean;

  // HTML Preview State
  previewFilePath: string | null;
  showPreviewPanel: boolean;

  // Permission Request State
  pendingPermissionRequest: PermissionRequest | null;

  // Model Config
  modelConfig: ModelConfig;

  // Workspace State
  workingDirectory: string | null;

  // Context Health State (上下文健康度)
  contextHealth: ContextHealthState | null;
  contextHealthCollapsed: boolean;

  // Actions
  setShowSettings: (show: boolean) => void;
  openSettingsTab: (tab: SettingsTab) => void; // 打开设置并跳转到指定 Tab
  clearSettingsInitialTab: () => void; // 清除初始 Tab（设置页使用后调用）
  setShowWorkspace: (show: boolean) => void;
  setShowTaskPanel: (show: boolean) => void;
  setShowSkillsPanel: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLanguage: (language: Language) => void;
  setCloudUIStrings: (strings: CloudUIStrings | null) => void;
  setDisclosureLevel: (level: DisclosureLevel) => void;
  setCurrentGeneration: (gen: Generation) => void;
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
  setShowEvaluation: (show: boolean) => void;
  setShowTelemetry: (show: boolean) => void;
  setPreviewFilePath: (path: string | null) => void;
  setShowPreviewPanel: (show: boolean) => void;
  openPreview: (filePath: string) => void;
  closePreview: () => void;
  setPendingPermissionRequest: (request: PermissionRequest | null) => void;
  setModelConfig: (config: ModelConfig) => void;
  // clearChat 简化：只清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () => void;
  setWorkingDirectory: (dir: string | null) => void;
  setContextHealth: (health: ContextHealthState | null) => void;
  setContextHealthCollapsed: (collapsed: boolean) => void;
}

// Default generation (Gen 1)
// 代际版本号：Gen1=v1.0, Gen2=v2.0, ..., Gen8=v8.0
// 注意: id 应与 shared/constants.ts 中的 DEFAULT_GENERATION ('gen8') 保持同步
const defaultGeneration: Generation = {
  id: 'gen8',
  name: 'Generation 8',
  version: 'v8.0',
  description: 'Full capabilities with self-evolution',
  tools: ['bash', 'read_file', 'write_file', 'edit_file'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 4, ruleCount: 0 },
};

// Default model config — 引用 shared/constants.ts 常量
// maxTokens 增加到 16384 以支持生成完整的代码文件和长篇回复
const defaultModelConfig: ModelConfig = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
  apiKey: '',
  baseUrl: MODEL_API_ENDPOINTS.kimiK25,
  temperature: 0.7,
  maxTokens: 16384,
};

export const useAppStore = create<AppState>((set, get) => ({
  // Initial UI State
  showSettings: false,
  settingsInitialTab: null,
  showWorkspace: false,
  showTaskPanel: true, // Task panel shown by default
  showSkillsPanel: false, // Skills panel hidden by default
  sidebarCollapsed: false,

  // 语言默认为中文
  language: defaultLanguage,

  // 云端 UI 字符串（初始为 null，由主进程推送）
  cloudUIStrings: null,

  // 渐进披露默认级别
  disclosureLevel: 'standard',

  // Initial Generation State
  currentGeneration: defaultGeneration,
  availableGenerations: [],

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

  // Initial Evaluation State
  showEvaluation: false,
  showTelemetry: false,

  // Initial HTML Preview State
  previewFilePath: null,
  showPreviewPanel: false,

  // Initial Permission Request State
  pendingPermissionRequest: null,

  // Initial Model Config
  modelConfig: defaultModelConfig,

  // Initial Workspace State
  workingDirectory: null,

  // Initial Context Health State
  contextHealth: null,
  contextHealthCollapsed: true, // 默认收起

  // Actions
  setShowSettings: (show) => set({ showSettings: show }),
  openSettingsTab: (tab) => set({ showSettings: true, settingsInitialTab: tab }),
  clearSettingsInitialTab: () => set({ settingsInitialTab: null }),
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setShowSkillsPanel: (show) => set({ showSkillsPanel: show }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setLanguage: (language) => set({ language }),
  setCloudUIStrings: (strings) => set({ cloudUIStrings: strings }),
  setDisclosureLevel: (level) => set({ disclosureLevel: level }),

  setCurrentGeneration: (gen) => set({ currentGeneration: gen }),

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
  setShowEvaluation: (show) => set({ showEvaluation: show }),
  setShowTelemetry: (show) => set({ showTelemetry: show }),

  setPreviewFilePath: (path) => set({ previewFilePath: path }),
  setShowPreviewPanel: (show) => set({ showPreviewPanel: show }),
  openPreview: (filePath) => set({ previewFilePath: filePath, showPreviewPanel: true }),
  closePreview: () => set({ previewFilePath: null, showPreviewPanel: false }),

  setPendingPermissionRequest: (request) => set({ pendingPermissionRequest: request }),

  setModelConfig: (config) => set({ modelConfig: config }),

  // 清除 planning 相关状态（messages/todos 由 sessionStore 管理）
  clearPlanningState: () =>
    set({ taskPlan: null, findings: [], errors: [] }),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setContextHealth: (health) => set({ contextHealth: health }),
  setContextHealthCollapsed: (collapsed) => set({ contextHealthCollapsed: collapsed }),
}));
