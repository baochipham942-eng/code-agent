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
} from '@shared/types';
import { defaultLanguage, type Language } from '../i18n';

// 渐进披露级别
export type DisclosureLevel = 'simple' | 'standard' | 'advanced' | 'expert';

interface AppState {
  // UI State
  showSettings: boolean;
  showWorkspace: boolean;
  sidebarCollapsed: boolean;

  // 语言设置 - Language
  language: Language;

  // 渐进披露 - Progressive Disclosure
  disclosureLevel: DisclosureLevel;

  // Generation State
  currentGeneration: Generation;
  availableGenerations: Generation[];

  // Chat State
  messages: Message[];
  isProcessing: boolean;
  currentSessionId: string | null;

  // Todo State (for Gen 3+)
  todos: TodoItem[];

  // Planning State (for Gen 3+ persistent planning)
  taskPlan: TaskPlan | null;
  findings: Finding[];
  errors: ErrorRecord[];
  showPlanningPanel: boolean;

  // Model Config
  modelConfig: ModelConfig;

  // Actions
  setShowSettings: (show: boolean) => void;
  setShowWorkspace: (show: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setLanguage: (language: Language) => void;
  setDisclosureLevel: (level: DisclosureLevel) => void;
  setCurrentGeneration: (gen: Generation) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  setIsProcessing: (processing: boolean) => void;
  setTodos: (todos: TodoItem[]) => void;
  setTaskPlan: (plan: TaskPlan | null) => void;
  setFindings: (findings: Finding[]) => void;
  setErrors: (errors: ErrorRecord[]) => void;
  setShowPlanningPanel: (show: boolean) => void;
  setModelConfig: (config: ModelConfig) => void;
  clearChat: () => void;
  setCurrentSessionId: (id: string | null) => void;
}

// Default generation (Gen 1)
const defaultGeneration: Generation = {
  id: 'gen1',
  name: 'Generation 1',
  version: 'v0.2 Beta',
  description: 'Basic file operations and shell commands',
  tools: ['bash', 'read_file', 'write_file', 'edit_file'],
  systemPrompt: '',
  promptMetadata: { lineCount: 0, toolCount: 4, ruleCount: 0 },
};

// Default model config (DeepSeek)
const defaultModelConfig: ModelConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  temperature: 0.7,
  maxTokens: 4096,
};

export const useAppStore = create<AppState>((set) => ({
  // Initial UI State
  showSettings: false,
  showWorkspace: false,
  sidebarCollapsed: false,

  // 语言默认为中文
  language: defaultLanguage,

  // 渐进披露默认级别
  disclosureLevel: 'standard',

  // Initial Generation State
  currentGeneration: defaultGeneration,
  availableGenerations: [],

  // Initial Chat State
  messages: [],
  isProcessing: false,
  currentSessionId: null,

  // Initial Todo State
  todos: [],

  // Initial Planning State
  taskPlan: null,
  findings: [],
  errors: [],
  showPlanningPanel: false,

  // Initial Model Config
  modelConfig: defaultModelConfig,

  // Actions
  setShowSettings: (show) => set({ showSettings: show }),
  setShowWorkspace: (show) => set({ showWorkspace: show }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setLanguage: (language) => set({ language }),
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

  setTodos: (todos) => set({ todos }),

  setTaskPlan: (plan) => set({ taskPlan: plan }),

  setFindings: (findings) => set({ findings }),

  setErrors: (errors) => set({ errors }),

  setShowPlanningPanel: (show) => set({ showPlanningPanel: show }),

  setModelConfig: (config) => set({ modelConfig: config }),

  clearChat: () =>
    set({ messages: [], todos: [], taskPlan: null, findings: [], errors: [] }),

  setCurrentSessionId: (id) => set({ currentSessionId: id }),
}));
