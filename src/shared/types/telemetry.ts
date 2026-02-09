// ============================================================================
// Telemetry Types - 会话遥测数据类型定义
// ============================================================================

// ----------------------------------------------------------------------------
// Intent Classification
// ----------------------------------------------------------------------------

export type UserIntentCategory =
  | 'code_generation'
  | 'bug_fix'
  | 'code_review'
  | 'explanation'
  | 'refactoring'
  | 'file_operation'
  | 'search'
  | 'conversation'
  | 'planning'
  | 'multi_step_task'
  | 'testing'
  | 'documentation'
  | 'configuration'
  | 'research'
  | 'unknown';

export interface IntentClassification {
  primary: UserIntentCategory;
  secondary?: UserIntentCategory;
  confidence: number; // 0-1
  method: 'rule' | 'llm';
  keywords: string[];
}

// ----------------------------------------------------------------------------
// Outcome Evaluation
// ----------------------------------------------------------------------------

export type OutcomeStatus = 'success' | 'partial' | 'failure' | 'unknown';

export interface QualitySignals {
  toolSuccessRate: number;
  toolCallCount: number;
  retryCount: number;
  errorCount: number;
  errorRecovered: number;
  compactionTriggered: boolean;
  circuitBreakerTripped: boolean;
  nudgesInjected: number;
}

export interface OutcomeEvaluation {
  status: OutcomeStatus;
  confidence: number;
  method: 'rule' | 'llm';
  signals: QualitySignals;
}

// ----------------------------------------------------------------------------
// Model Call Record
// ----------------------------------------------------------------------------

export interface TelemetryModelCall {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  responseType: 'text' | 'tool_use' | 'thinking';
  toolCallCount: number;
  truncated: boolean;
  error?: string;
  fallbackUsed?: { from: string; to: string; reason: string };
}

// ----------------------------------------------------------------------------
// Tool Call Record
// ----------------------------------------------------------------------------

export interface TelemetryToolCall {
  id: string;
  toolCallId: string;
  name: string;
  arguments: string; // JSON (truncated to 2KB)
  resultSummary: string; // first 500 chars
  success: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
  index: number; // index within turn
  parallel: boolean;
}

// ----------------------------------------------------------------------------
// Timeline Event
// ----------------------------------------------------------------------------

export interface TelemetryTimelineEvent {
  id: string;
  timestamp: number;
  eventType: string; // AgentEvent.type
  summary: string; // ≤200 char summary
  data?: string; // JSON of key fields
  durationMs?: number;
}

// ----------------------------------------------------------------------------
// Turn Record (core)
// ----------------------------------------------------------------------------

export interface TelemetryTurn {
  id: string;
  sessionId: string;
  turnNumber: number;
  startTime: number;
  endTime: number;
  durationMs: number;

  // User input
  userPrompt: string;
  userPromptTokens: number;
  hasAttachments: boolean;
  attachmentCount: number;

  // System context
  systemPromptHash?: string; // SHA-256, avoid storing full text
  agentMode: string;
  activeSkills?: string[];
  activeMcpServers?: string[];
  effortLevel: string;

  // Model calls (possibly >1: retries/re-inference)
  modelCalls: TelemetryModelCall[];

  // Tool calls (ordered)
  toolCalls: TelemetryToolCall[];

  // Model output
  assistantResponse: string;
  assistantResponseTokens: number;
  thinkingContent?: string;

  // Token summary
  totalInputTokens: number;
  totalOutputTokens: number;

  // Event timeline
  events: TelemetryTimelineEvent[];

  // Classification & evaluation
  intent: IntentClassification;
  outcome: OutcomeEvaluation;

  // Other
  compactionOccurred: boolean;
  compactionSavedTokens?: number;
  iterationCount: number;
}

// ----------------------------------------------------------------------------
// Session Record
// ----------------------------------------------------------------------------

export interface TelemetrySession {
  id: string;
  title: string;
  generationId: string;
  modelProvider: string;
  modelName: string;
  workingDirectory: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;

  // Aggregate metrics
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  totalToolCalls: number;
  toolSuccessRate: number;
  totalErrors: number;
  sessionType?: UserIntentCategory; // dominant intent
  status: 'recording' | 'completed' | 'error';
}

// ----------------------------------------------------------------------------
// Telemetry Adapter (injected into AgentLoop)
// ----------------------------------------------------------------------------

export interface TelemetryAdapter {
  onTurnStart(turnId: string, turnNumber: number, userPrompt: string): void;
  onModelCall(turnId: string, call: TelemetryModelCall): void;
  onToolCallStart(turnId: string, toolCallId: string, name: string, args: unknown, index: number, parallel: boolean): void;
  onToolCallEnd(turnId: string, toolCallId: string, success: boolean, error: string | undefined, durationMs: number, output: string | undefined): void;
  onTurnEnd(turnId: string, assistantResponse: string, thinking?: string, systemPromptHash?: string): void;
}

// ----------------------------------------------------------------------------
// IPC Payloads
// ----------------------------------------------------------------------------

export interface TelemetrySessionListItem {
  id: string;
  title: string;
  modelProvider: string;
  modelName: string;
  startTime: number;
  endTime?: number;
  turnCount: number;
  totalTokens: number;
  estimatedCost: number;
  status: string;
}

export interface TelemetryToolStat {
  name: string;
  callCount: number;
  successCount: number;
  failCount: number;
  successRate: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

export interface TelemetryIntentStat {
  intent: UserIntentCategory;
  count: number;
  percentage: number;
}

// Telemetry event for real-time push
export interface TelemetryPushEvent {
  type: 'session_start' | 'session_end' | 'turn_start' | 'turn_end' | 'tool_call' | 'model_call';
  sessionId: string;
  data: unknown;
}
