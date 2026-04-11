// ============================================================================
// IPC Types - 业务类型定义
// ============================================================================

import type {
  Message,
  MessageAttachment,
  PermissionResponse,
  TodoItem,
} from '../types';

import type {
  ObjectiveMetrics,
  SubjectiveAssessment,
} from '../types/sessionAnalytics';

// 带附件的消息请求
export interface AgentMessageRequest {
  content: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
}

export interface AgentCancelRequest {
  sessionId?: string;
}

export interface AgentPermissionResponseRequest {
  requestId: string;
  response: PermissionResponse;
  sessionId?: string;
}

// 会话分析结果（客观指标 + 历史评测 + SSE事件摘要）
export interface SessionAnalysisResult {
  sessionInfo: {
    title: string;
    modelProvider: string;
    modelName: string;
    startTime: number;
    endTime?: number;
    generationId: string;
    workingDirectory: string;
    status: string;
    turnCount: number;
    totalTokens: number;
    estimatedCost: number;
  } | null;
  objective: ObjectiveMetrics;
  previousEvaluations: {
    id: string;
    timestamp: number;
    overallScore: number;
    grade: string;
  }[];
  latestEvaluation: {
    id: string;
    sessionId: string;
    timestamp: number;
    objective: ObjectiveMetrics;
    subjective: SubjectiveAssessment | null;
  } | null;
  eventSummary: {
    eventStats: Record<string, number>;
    toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
    thinkingContent: string[];
    errorEvents: Array<{ type: string; message: string }>;
    timeline: Array<{ time: number; type: string; summary: string }>;
  } | null;
}

// ----------------------------------------------------------------------------
// TaskList IPC Types
// ----------------------------------------------------------------------------

export type TaskItemStatusIpc = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TaskItemIpc {
  id: string;
  subject: string;
  description: string;
  status: TaskItemStatusIpc;
  assignee?: string;
  priority: number;
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
}

export interface TaskListStateIpc {
  tasks: TaskItemIpc[];
  autoAssign: boolean;
  requireApproval: boolean;
}

export interface TaskListEventIpc {
  type: string;
  task?: TaskItemIpc;
  taskId?: string;
  changes?: Partial<TaskItemIpc>;
  assignee?: string;
  reason?: string;
  result?: string;
  error?: string;
  state?: TaskListStateIpc;
}

// ----------------------------------------------------------------------------
// Additional Types for IPC
// ----------------------------------------------------------------------------

export interface SessionExport {
  id: string;
  title: string;
  generationId?: string;
  modelConfig: any;
  workingDirectory?: string;
  messages: Message[];
  todos: TodoItem[];
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: {
    source: 'file' | 'conversation' | 'knowledge';
    path?: string;
    sessionId?: string;
    category?: string;
    timestamp?: number;
  };
}

export interface MemoryContextResult {
  ragContext: string;
  projectKnowledge: Array<{ key: string; value: any }>;
  relevantCode: SearchResult[];
  relevantConversations: SearchResult[];
}

export interface MemoryStats {
  sessionCount: number;
  messageCount: number;
  toolCacheSize: number;
  vectorStoreSize: number;
  projectKnowledgeCount: number;
}

/**
 * Memory Record - Gen5 记忆可视化
 */
export interface MemoryRecord {
  id: string;
  type: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
  category: string;
  content: string;
  summary: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath: string | null;
  sessionId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface MemoryListFilter {
  type?: MemoryRecord['type'];
  category?: string;
  source?: MemoryRecord['source'];
  currentProjectOnly?: boolean;
  currentSessionOnly?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: 'created_at' | 'updated_at' | 'access_count' | 'confidence';
  orderDir?: 'ASC' | 'DESC';
}

export interface MemorySearchOptions {
  type?: MemoryRecord['type'];
  category?: string;
  limit?: number;
}

export interface MemoryStatsResult {
  total: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface MCPStatus {
  connectedServers: string[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: any;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface CacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
}

export interface DataStats {
  sessionCount: number;
  messageCount: number;
  toolExecutionCount: number;
  knowledgeCount: number;
  databaseSize: number; // bytes
  cacheEntries: number;
}

// ----------------------------------------------------------------------------
// Test Report types (CLI 评测报告)
// ----------------------------------------------------------------------------

export interface TestReportListItem {
  fileName: string;
  filePath: string;
  timestamp: number;
  model: string;
  provider: string;
  total: number;
  passed: number;
  failed: number;
  partial: number;
  averageScore: number;
}

export interface TestExpectation {
  type: string;
  description: string;
  weight: number;
  critical?: boolean;
  params: Record<string, unknown>;
}

export interface TestExpectationResult {
  expectation: TestExpectation;
  passed: boolean;
  evidence: { actual: string; expected: string };
  duration: number;
}

export interface TestToolExecution {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  success: boolean;
  duration: number;
  timestamp: number;
}

export interface TestCaseResult {
  testId: string;
  description: string;
  status: 'passed' | 'failed' | 'partial' | 'skipped';
  duration: number;
  startTime: number;
  endTime: number;
  toolExecutions: TestToolExecution[];
  responses: string[];
  errors: string[];
  turnCount: number;
  score: number;
  failureReason?: string;
  /** Pipeline failure stage (from failure funnel analysis) */
  failureStage?: string;
  reference_solution?: string;
  /** Stability metrics (present when trialsPerCase > 1) */
  variance?: number;
  stdDev?: number;
  unstable?: boolean;
  expectationResults?: TestExpectationResult[];
  category?: string;
  difficulty?: string;
}

export interface TestRunReport {
  runId: string;
  startTime: number;
  endTime: number;
  duration: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  partial: number;
  averageScore: number;
  results: TestCaseResult[];
  environment: {
    generation: string;
    model: string;
    provider: string;
    workingDirectory: string;
  };
  performance: {
    avgResponseTime: number;
    maxResponseTime: number;
    totalToolCalls: number;
    totalTurns: number;
  };
  evalFeedback?: unknown;
  gitCommit?: string;
  /** Stability metrics (present when trialsPerCase > 1) */
  unstableCaseCount?: number;
  averageStdDev?: number;
}

export type EvalAnnotationErrorType =
  | 'tool_misuse'
  | 'reasoning_error'
  | 'incomplete_output'
  | 'hallucination'
  | 'security_violation';

export interface EvalAnnotationPayload {
  id: string;
  caseId: string;
  round: number;
  timestamp: string;
  errorTypes: EvalAnnotationErrorType[];
  rootCause: string;
  severity: 1 | 2 | 3 | 4 | 5;
  annotator: string;
}

export interface AxialCodingEntryIpc {
  errorType: EvalAnnotationErrorType;
  count: number;
  avgSeverity: number;
  caseIds: string[];
}

// ----------------------------------------------------------------------------
// Cross-session search types (跨会话搜索)
// ----------------------------------------------------------------------------

export interface CrossSessionSearchOptions {
  /** Maximum results to return */
  limit?: number;
  /** Filter by message role */
  role?: 'user' | 'assistant' | 'system';
  /** Case-sensitive search */
  caseSensitive?: boolean;
}

export interface CrossSessionSearchMatch {
  /** Start position of match */
  start: number;
  /** End position of match */
  end: number;
  /** Matched text */
  text: string;
}

export interface CrossSessionSearchResultItem {
  /** Session ID */
  sessionId: string;
  /** Session title (for display) */
  sessionTitle?: string;
  /** Message role */
  role: 'user' | 'assistant' | 'system';
  /** Message timestamp */
  timestamp: number;
  /** Relevance score (0-1) */
  relevance: number;
  /** Highlighted content snippet */
  snippet: string;
  /** Match count in this message */
  matchCount: number;
}

export interface CrossSessionSearchResults {
  /** Search query */
  query: string;
  /** Total matches found */
  totalMatches: number;
  /** Number of sessions with matches */
  sessionsWithMatches: number;
  /** Individual results */
  results: CrossSessionSearchResultItem[];
  /** Search time (ms) */
  searchTime: number;
  /** Whether results were truncated */
  truncated: boolean;
}
