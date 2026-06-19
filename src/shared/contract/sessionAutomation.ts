// ============================================================================
// Session Automation — 会话级自动化闭环契约
// ============================================================================

export type SessionAutomationType = 'cron' | 'heartbeat' | 'loop' | 'role_wake' | 'goal_phase';

export type SessionAutomationStatus =
  | 'active'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'skipped'
  | 'archived';

export type SessionAutomationEventKind =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'stage_ready';

export interface SessionAutomationNextStageConfig {
  /** Explicit prompt to send back into the source session when this automation reaches a terminal success state. */
  prompt?: string;
  /** Optional human label used in feedback messages. */
  title?: string;
  /** Future extension point for goal-mode launches; prompt is the only executable field in this slice. */
  goal?: string;
}

export interface SessionAutomationConfig extends Record<string, unknown> {
  createdVia?: string;
  sourceMessageId?: string;
  handoffPrompt?: string;
  nextStage?: SessionAutomationNextStageConfig;
}

export interface SessionAutomationRecord {
  id: string;
  sourceSessionId: string;
  type: SessionAutomationType;
  status: SessionAutomationStatus;
  title: string;
  cadenceLabel?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  sourceRefId?: string;
  resultSessionId?: string;
  config?: SessionAutomationConfig;
  createdAt: number;
  updatedAt: number;
}

export interface SessionAutomationSummaryItem {
  id: string;
  type: SessionAutomationType;
  status: SessionAutomationStatus;
  title: string;
  cadenceLabel?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  sourceRefId?: string;
  resultSessionId?: string;
}

export interface SessionAutomationSessionSummary {
  sessionId: string;
  total: number;
  activeCount: number;
  runningCount: number;
  nextRunAt?: number;
  label?: string;
  tooltip: string;
  items: SessionAutomationSummaryItem[];
}

export interface SessionAutomationMessageMetadata {
  automationId: string;
  automationType: SessionAutomationType;
  event: SessionAutomationEventKind;
  sourceSessionId: string;
  sourceRefId?: string;
  resultSessionId?: string;
  status?: SessionAutomationStatus;
  title?: string;
  cadenceLabel?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  handoffPrompt?: string;
  nextStage?: SessionAutomationNextStageConfig;
}

export interface UpsertSessionAutomationInput {
  id?: string;
  sourceSessionId: string;
  type: SessionAutomationType;
  status?: SessionAutomationStatus;
  title: string;
  cadenceLabel?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  sourceRefId?: string;
  resultSessionId?: string;
  config?: SessionAutomationConfig;
}
