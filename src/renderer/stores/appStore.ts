// ============================================================================
// App Store - Global Application State
// ============================================================================

import { create } from 'zustand';
import type {
  Generation,
  Message,
  TodoItem,
  ModelConfig,
  TaskPlan,
  Finding,
  ErrorRecord,
  PermissionRequest,
} from '@shared/types';
import type { ContextHealthState } from '@shared/types/contextHealth';
import { defaultLanguage, type Language } from '../i18n';

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

// 云端 UI 字符串类型
type CloudUIStrings = {
  zh: Record<string, string>;
  en: Record<string, string>;
};

interface AppState {
  // UI State
  showSettings: boolean;
  showWorkspace: boolean;
  showTaskPanel: boolean;
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

  // Chat State
  messages: Message[];
  isProcessing: boolean;
  // 按会话追踪处理状态（支持多会话并发）
  processingSessionIds: Set<string>;
  currentSessionId: string | null;

  // Todo State (for Gen 3+)
  todos: TodoItem[];

  // Planning State (for Gen 3+ persistent planning)
  taskPlan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];
  showPlanningPanel: boolean;

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
  setShowWorkspace: (show: boolean) => void;
  setShowTaskPanel: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLanguage: (language: Language) => void;
  setCloudUIStrings: (strings: CloudUIStrings | null) => void;
  setDisclosureLevel: (level: DisclosureLevel) => void;
  setCurrentGeneration: (gen: Generation) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setIsProcessing: (processing: boolean) => void;
  // 按会话设置处理状态
  setSessionProcessing: (sessionId: string, processing: boolean) => void;
  // 检查指定会话是否正在处理
  isSessionProcessing: (sessionId: string) => boolean;
  setTodos: (todos: TodoItem[]) => void;
  setTaskPlan: (plan: TaskPlan | null) => void;
  setFindings: (findings: Finding[]) => void;
  setErrors: (errors: ErrorRecord[]) => void;
  setShowPlanningPanel: (show: boolean) => void;
  setPreviewFilePath: (path: string | null) => void;
  setShowPreviewPanel: (show: boolean) => void;
  openPreview: (filePath: string) => void;
  closePreview: () => void;
  setPendingPermissionRequest: (request: PermissionRequest | null) => void;
  setModelConfig: (config: ModelConfig) => void;
  clearChat: () => void;
  setCurrentSessionId: (id: string | null) => void;
  setWorkingDirectory: (dir: string | null) => void;
  setContextHealth: (health: ContextHealthState | null) => void;
  setContextHealthCollapsed: (collapsed: boolean) => void;
}

// Default generation (Gen 1)
// 代际版本号：Gen1=v1.0, Gen2=v2.0, ..., Gen8=v8.0
const defaultGeneration: Generation = {
  id: 'gen1',
  name: 'Generation 1',
  version: 'v1.0',
  description: 'Basic file operations and shell commands',
  tools: ['bash', 'read_file', 'write_file', 'edit_file'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 4, ruleCount: 0 },
};

// Default model config (DeepSeek)
// maxTokens 增加到 16384 以支持生成完整的代码文件和长篇回复
const defaultModelConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  temperature: 0.7,
  maxTokens: 16384,
};

export const useAppStore = create<AppState>((set, get) => ({
  // Initial UI State
  showSettings: false,
  showWorkspace: false,
  showTaskPanel: true, // Task panel shown by default
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

  // Initial Chat State
  messages: [],
  isProcessing: false,
  processingSessionIds: new Set<string>(),
  currentSessionId: null,

  // Initial Todo State
  todos: [],

  // Initial Planning State
  taskPlan: null,
  findings: [],
  errors: [],
  showPlanningPanel: false,

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
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setShowTaskPanel: (show) => set({ showTaskPanel: show }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setLanguage: (language) => set({ language }),
  setCloudUIStrings: (strings) => set({ cloudUIStrings: strings }),
  setDisclosureLevel: (level) => set({ disclosureLevel: level }),

  setCurrentGeneration: (gen) => set({ currentGeneration: gen }),

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, ...updates } : msg
      ),
    })),

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
      // 当前会话正在处理时，全局也标记为处理中
      const isCurrentProcessing = state.currentSessionId ? newSet.has(state.currentSessionId) : false;
      return { processingSessionIds: newSet, isProcessing: isCurrentProcessing };
    }),

  // 检查指定会话是否正在处理
  isSessionProcessing: (sessionId) => get().processingSessionIds.has(sessionId),

  setTodos: (todos) => set({ todos }),

  setTaskPlan: (plan) => set({ taskPlan: plan }),

  setFindings: (findings) => set({ findings }),

  setErrors: (errors) => set({ errors }),

  setShowPlanningPanel: (show) => set({ showPlanningPanel: show }),

  setPreviewFilePath: (path) => set({ previewFilePath: path }),
  setShowPreviewPanel: (show) => set({ showPreviewPanel: show }),
  openPreview: (filePath) => set({ previewFilePath: filePath, showPreviewPanel: true }),
  closePreview: () => set({ previewFilePath: null, showPreviewPanel: false }),

  setPendingPermissionRequest: (request) => set({ pendingPermissionRequest: request }),

  setModelConfig: (config) => set({ modelConfig: config }),

  clearChat: () =>
    set({ messages: [], todos: [], taskPlan: null, findings: [], errors: [] }),

  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  setWorkingDirectory: (dir) => set({ workingDirectory: dir }),

  setContextHealth: (health) => set({ contextHealth: health }),
  setContextHealthCollapsed: (collapsed) => set({ contextHealthCollapsed: collapsed }),
}));
