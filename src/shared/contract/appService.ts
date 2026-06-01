// ============================================================================
// AgentApplicationService — IPC 层与业务实现之间的窄接口
//
// IPC handler 只依赖此接口，不直接 import AgentOrchestrator / TaskManager 等
// 具体实现类。适配器（src/main/app/agentAppService.ts）负责委托给实际服务。
// ============================================================================

import type { PermissionResponse } from './permission';
import type { Session } from './session';
import type { SessionTask } from './planning';
import type { AgentEngineSessionMetadata } from './agentEngine';
import type { Message, MessageAttachment } from './message';
import type { ModelProvider } from './model';
import type {
  ConversationEnvelope,
  ConversationExecutionIntent,
  RuntimeInputIntent,
  WorkbenchToolScope,
} from './conversationEnvelope';

export type AppServiceRunMode = 'normal' | 'deep-research';
export type AppServiceReportStyle =
  | 'academic'
  | 'popular_science'
  | 'news'
  | 'social_media'
  | 'strategic_investment'
  | 'default';

/**
 * /goal 自治模式输入（renderer 解析斜杠命令后随 envelope 带出）。
 * 字段与 web /api/run 的 body.goal 对齐；纯目标输入会在 renderer 补默认 review 判据。
 */
export interface GoalRunInput {
  /** 自然语言目标；缺省时下游回落到本轮 prompt */
  goal?: string;
  /** 闸1：退出码 0 即硬达成的 shell 命令（硬目标） */
  verify?: string;
  /** 闸2：交给 Reviewer 子代理评的软条件（软目标） */
  review?: string;
  /** 闸3：token 预算上限 */
  budget?: number;
  /** 闸3：轮次上限 */
  maxTurns?: number;
}

/**
 * Agent 运行选项（与 AgentRunOptions 对齐，但不引入 research 模块依赖）
 */
export interface AppServiceRunOptions {
  mode?: AppServiceRunMode;
  researchMode?: boolean;
  reportStyle?: AppServiceReportStyle;
  agentOverrideId?: string | null;
  turnSystemContext?: string[];
  toolScope?: WorkbenchToolScope;
  executionIntent?: ConversationExecutionIntent;
  runtimeInput?: RuntimeInputIntent;
  /** /goal 自治模式：存在则本轮激活 goal 模式 */
  goal?: GoalRunInput;
  [key: string]: unknown;
}

/**
 * 会话创建配置
 */
export interface CreateSessionConfig {
  title?: string;
  workingDirectory?: string | null;
  engine?: Partial<AgentEngineSessionMetadata> | null;
}

/**
 * 模型切换参数
 */
export interface SwitchModelParams {
  sessionId: string;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** true 表示用户选择"自动"路由（按任务复杂度切换 free/default model）；false 或缺省 = 严格使用指定模型 */
  adaptive?: boolean;
}

/**
 * 模型覆盖信息
 */
export interface ModelOverride {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** true 表示"自动路由"模式，允许 adaptiveRouter 按任务复杂度切 free/default model */
  adaptive?: boolean;
}

export interface SessionMarkdownExport {
  markdown: string;
  suggestedFileName: string;
  stats?: {
    messageCount: number;
    characterCount: number;
    codeBlockCount: number;
    toolExecutionCount: number;
  };
}

export interface PromptRewindDraft {
  content: string;
  attachments?: MessageAttachment[];
}

export interface PromptRewindResult {
  success: true;
  sessionId: string;
  rewindId: string;
  draft: PromptRewindDraft;
  activeMessages: Message[];
  hiddenMessageCount: number;
  filesRestored: number;
  filesDeleted: number;
}

/**
 * AgentApplicationService — IPC handler 的唯一业务依赖
 *
 * 设计原则：
 * - Facade 而非抽象层：方法命名直接对应业务操作
 * - 窄接口：只暴露 IPC handler 需要的方法
 * - 不改变 IPC channel 名称或参数格式（前端零改动）
 */
export interface AgentApplicationService {
  // === Agent Operations ===
  sendMessage(envelope: ConversationEnvelope): Promise<void>;
  cancel(sessionId?: string): Promise<void>;
  handlePermissionResponse(requestId: string, response: PermissionResponse, sessionId?: string): void;
  interruptAndContinue(envelope: ConversationEnvelope): Promise<void>;

  // === Workspace ===
  getWorkingDirectory(): string | undefined;
  setWorkingDirectory(dir: string): void;

  // === Session Lifecycle ===
  createSession(config?: CreateSessionConfig): Promise<Session>;
  loadSession(sessionId: string): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(options?: { includeArchived?: boolean }): Promise<Session[]>;
  updateSession(sessionId: string, updates: Partial<Session>): Promise<void>;
  archiveSession(sessionId: string): Promise<Session | null>;
  unarchiveSession(sessionId: string): Promise<Session | null>;
  getMessages(sessionId: string): Promise<Message[]>;
  getSessionTasks(sessionId: string): Promise<SessionTask[]>;
  rewindToPrompt(params: { sessionId: string; userMessageId: string }): Promise<PromptRewindResult>;
  getSerializedCompressionState(sessionId?: string): string | null;
  loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }>;
  exportSession(sessionId: string): Promise<unknown>;
  exportSessionMarkdown(sessionId: string): Promise<SessionMarkdownExport>;
  importSession(data: unknown): Promise<string>;

  // === Session State ===
  getCurrentSessionId(): string | null;
  setCurrentSessionId(id: string): void;

  // === Memory ===
  getMemoryContext(sessionId: string, workingDirectory?: string, query?: string): Promise<unknown>;

  // === Model Override ===
  switchModel(params: SwitchModelParams): void;
  getModelOverride(sessionId: string): ModelOverride | undefined;
  clearModelOverride(sessionId: string): void;

  // === Delegate Mode ===
  setDelegateMode(enabled: boolean): void;
  isDelegateMode(): boolean;

  // === Effort Level ===
  setEffortLevel(level: import('./agent').EffortLevel): void;
  setThinkingEnabled(enabled: boolean): void;

  // === Interaction Mode ===
  setInteractionMode(mode: import('./agent').InteractionMode): void;

  // === Pause / Resume ===
  pause(sessionId?: string): void;
  resume(sessionId?: string): void;
}
