// ============================================================================
// Session Automation — 会话级自动化闭环契约
// ============================================================================

export type SessionAutomationType = 'cron' | 'heartbeat' | 'loop' | 'role_wake' | 'goal_phase' | 'external_event';

export type SessionAutomationStatus =
  | 'active'
  | 'running'
  | 'completed'
  | 'pending_review'
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
  /** 最近一次成功运行的待过目标记；用户过目/归档后清除。recurring 任务记录保持 active，靠它进待审收件箱。 */
  pendingReview?: { resultSessionId?: string; at: number };
}

export interface SessionAutomationRecord {
  id: string;
  /** 源会话 id；null = 面板/API 创建（无会话回流，仅生命周期与待过目） */
  sourceSessionId: string | null;
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
  sourceSessionId: string | null;
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
