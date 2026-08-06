// ============================================================================
// AgentApplicationService — IPC 层与业务实现之间的窄接口
//
// IPC handler 只依赖此接口，不直接 import AgentOrchestrator / TaskManager 等
// 具体实现类。适配器（src/host/app/agentAppService.ts）负责委托给实际服务。
// ============================================================================

import type { PermissionDeliveryOutcome, PermissionResponse } from './permission';
import type { Session } from './session';
import type { SessionTask } from './planning';
import type { AgentEngineSessionMetadata } from './agentEngine';
import type { Message, MessageAttachment } from './message';
import type { ModelProvider } from './model';
import type {
  CreateSessionForkRequest,
  CreateSessionForkResult,
  SessionForkLineageSummary,
} from './sessionFork';
import type {
  RestoreConversationRewindRequest,
  RestoreConversationRewindResult,
  RewindConversationRequest,
  RewindConversationResult,
} from './sessionRewind';
import type {
  RestoreWorkspaceFilesAtCheckpointRequest,
  RestoreWorkspaceFilesAtCheckpointResult,
} from './fileRestore';
import type {
  ConversationBranchComparison,
  ConversationEvaluationAttribution,
  ConversationLineageAudit,
  ConversationProvenanceTrace,
  ConversationReplay,
} from './conversationBranch';
import type {
  EnqueueSessionForkSyncRequest,
  ExportSessionForkRequest,
  ForkNeighborhoodProjection,
  ForkSearchDocument,
  ForkTreeNodeProjection,
  ImportReadySessionForkSyncRequest,
  ImportReadySessionForkSyncResponse,
  ImportSessionForkRequest,
  ImportSessionForkResponse,
  IngestSessionForkSyncRequest,
  ReadSessionForkNeighborhoodRequest,
  ReadSessionForkTreeRequest,
  SearchSessionForkExportsRequest,
  SessionExportEnvelopeV2,
  SessionForkSyncEnvelopeRecord,
} from './sessionForkPortability';
import type {
  ConversationEnvelope,
  ConversationExecutionIntent,
  ConversationModelSpec,
  RuntimeInputIntent,
  WorkbenchToolScope,
} from './conversationEnvelope';

export type AppServiceRunMode = 'normal' | 'deep-research';
export type {
  RestoreWorkspaceFilesAtCheckpointRequest,
  RestoreWorkspaceFilesAtCheckpointResult,
} from './fileRestore';
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
  /** 闸3：墙钟时间预算上限（ms，可选）。缺省 = 不限时——防 token/轮次没超却卡在慢动作里耗时间。 */
  wallClockBudgetMs?: number;
  /**
   * 是否允许 swarm 扇出（P4，内部文档）。缺省 = true（交互式 /goal）；
   * 角色主动性 advance 发起的无人值守 goal run 传 false。
   */
  allowSwarm?: boolean;
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
  /** 排队输入在 host 侧捕获的显式模型；旧 envelope 缺省时仍走会话/全局解析。 */
  modelSpec?: ConversationModelSpec;
  /** Foreground command-center brain tool allowlist. Omitted for normal execution runs. */
  allowedToolNames?: string[];
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
	  metadata?: Record<string, unknown>;
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
 * 模型切换/清除的持久化结果（audit R1-HIGH2：落库失败不静默，标志透出）。
 * persisted=false 表示内存已生效但未落库（重启后不恢复，如无 DB 的 web 模式）。
 */
export interface ModelOverridePersistResult {
  persisted: boolean;
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

/** 会话诊断导出；v2 ZIP 通过 base64 跨 IPC，legacy JSON 保留一版。 */
export interface SessionLogExport {
  content: string;
  suggestedFileName: string;
  encoding?: 'utf8' | 'base64';
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
  workspaceChanged: false;
}

export type SteerOrQueueOutcome =
  | { outcome: 'steered' }
  | { outcome: 'queued'; queuedInputId: string };

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
  /** 回报投递结果：'no_orchestrator'/'unknown_request' = 停车审批宿主已死，行已被标 orphaned */
  handlePermissionResponse(requestId: string, response: PermissionResponse, sessionId?: string): PermissionDeliveryOutcome;
  interruptAndContinue(envelope: ConversationEnvelope): Promise<SteerOrQueueOutcome>;

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
  forkSession(params: CreateSessionForkRequest): Promise<CreateSessionForkResult>;
  getForkLineage(sessionId: string): Promise<SessionForkLineageSummary | null>;
  listForkChildren(sessionId: string): Promise<SessionForkLineageSummary[]>;
  exportSessionFork(params: ExportSessionForkRequest): Promise<SessionExportEnvelopeV2>;
  importSessionFork(params: ImportSessionForkRequest): Promise<ImportSessionForkResponse>;
  enqueueSessionForkSync(
    params: EnqueueSessionForkSyncRequest,
  ): Promise<SessionForkSyncEnvelopeRecord>;
  ingestSessionForkSync(
    params: IngestSessionForkSyncRequest,
  ): Promise<SessionForkSyncEnvelopeRecord>;
  importReadySessionForkSync(
    params: ImportReadySessionForkSyncRequest,
  ): Promise<ImportReadySessionForkSyncResponse>;
  searchSessionForkExports(
    params: SearchSessionForkExportsRequest,
  ): Promise<ForkSearchDocument[]>;
  readSessionForkTree(params: ReadSessionForkTreeRequest): Promise<ForkTreeNodeProjection>;
  readSessionForkNeighborhood(
    params: ReadSessionForkNeighborhoodRequest,
  ): Promise<ForkNeighborhoodProjection>;
  replayConversationBranch(
    sessionId: string,
    options?: { includeRewound?: boolean; allowRepairOverride?: boolean },
  ): Promise<ConversationReplay>;
  compareConversationBranches(
    leftSessionId: string,
    rightSessionId: string,
  ): Promise<ConversationBranchComparison>;
  traceConversationProvenance(
    sessionId: string,
    messageId: string,
  ): Promise<ConversationProvenanceTrace>;
  auditConversationLineage(sessionId: string): Promise<ConversationLineageAudit>;
  quarantineConversationLineage(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ConversationLineageAudit>;
  repairConversationLineage(params: {
    sessionId: string;
    issueDigest: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<ConversationLineageAudit>;
  recordConversationEvaluationAttribution(params: {
    sessionId: string;
    evaluationId: string;
    runId?: string | null;
    metric: string;
    value: number;
    attributedMessageIds: string[];
    idempotencyKey: string;
  }): Promise<ConversationEvaluationAttribution>;
  listConversationEvaluationAttributions(
    sessionId: string,
  ): Promise<ConversationEvaluationAttribution[]>;
  rewindConversation(params: RewindConversationRequest): Promise<RewindConversationResult>;
  restoreConversationRewind(params: RestoreConversationRewindRequest): Promise<RestoreConversationRewindResult>;
  restoreWorkspaceFilesAtCheckpoint(
    params: RestoreWorkspaceFilesAtCheckpointRequest,
  ): Promise<RestoreWorkspaceFilesAtCheckpointResult>;
  rewindToPrompt(params: { sessionId: string; userMessageId: string; idempotencyKey?: string }): Promise<PromptRewindResult>;
  getSerializedCompressionState(sessionId?: string): string | null;
  loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }>;
  exportSession(sessionId: string): Promise<unknown>;
  exportSessionMarkdown(sessionId: string): Promise<SessionMarkdownExport>;
  exportSessionDiagnostics(sessionId: string): Promise<SessionLogExport>;
  importSession(data: unknown): Promise<string>;

  // === Session State ===
  getCurrentSessionId(): string | null;
  setCurrentSessionId(id: string): void;

  // === Memory ===
  getMemoryContext(sessionId: string, workingDirectory?: string, query?: string): Promise<unknown>;

  // === Model Override ===
  switchModel(params: SwitchModelParams): Promise<ModelOverridePersistResult>;
  getModelOverride(sessionId: string): ModelOverride | undefined;
  clearModelOverride(sessionId: string): Promise<ModelOverridePersistResult>;

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
