// ============================================================================
// AgentApplicationService — IPC 层与业务实现之间的窄接口
//
// IPC handler 只依赖此接口，不直接 import AgentOrchestrator / TaskManager 等
// 具体实现类。适配器（src/main/app/agentAppService.ts）负责委托给实际服务。
// ============================================================================

import type { PermissionResponse } from './permission';
import type { Session } from './session';
import type { Message } from './message';
import type { ModelProvider } from './model';

/**
 * Agent 运行选项（与 AgentRunOptions 对齐，但不引入 research 模块依赖）
 */
export interface AppServiceRunOptions {
  researchMode?: boolean;
  [key: string]: unknown;
}

/**
 * 会话创建配置
 */
export interface CreateSessionConfig {
  title?: string;
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
}

/**
 * 模型覆盖信息
 */
export interface ModelOverride {
  provider: ModelProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
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
  sendMessage(content: string, attachments?: unknown[], options?: AppServiceRunOptions): Promise<void>;
  cancel(): Promise<void>;
  handlePermissionResponse(requestId: string, response: PermissionResponse): void;
  interruptAndContinue(content: string, attachments?: unknown[]): Promise<void>;

  // === Workspace ===
  getWorkingDirectory(): string | undefined;
  setWorkingDirectory(dir: string): void;

  // === Session Lifecycle ===
  createSession(config?: CreateSessionConfig): Promise<Session>;
  loadSession(sessionId: string): Promise<Session>;
  deleteSession(sessionId: string): Promise<void>;
  listSessions(options?: { includeArchived?: boolean }): Promise<Session[]>;
  archiveSession(sessionId: string): Promise<Session | null>;
  unarchiveSession(sessionId: string): Promise<Session | null>;
  getMessages(sessionId: string): Promise<Message[]>;
  loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }>;
  exportSession(sessionId: string): Promise<unknown>;
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
}
