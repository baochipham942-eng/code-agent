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

/**
 * B4 target 粒度长期授权规则。人工在停车审批卡点「每次都允许发 <target>」铸造，挂在
 * 该 automation 上（随 automation 归档/删除即撤权）。匹配 = (tool, target) 精确串，
 * 无 glob 无前缀模糊：target 不同必仍走审批（防 URL 变体/路径穿越绕过提权）。
 */
export interface StandingGrant {
  /** 工具内部名（精确匹配，如 mail_send / mcp__lark__im.v1.message.create） */
  tool: string;
  /** 授权目标精确串（白名单）——不同即须重新审批 */
  target: string;
  /** 铸造时间戳（epoch ms） */
  grantedAt: number;
}

export interface SessionAutomationConfig extends Record<string, unknown> {
  createdVia?: string;
  sourceMessageId?: string;
  handoffPrompt?: string;
  nextStage?: SessionAutomationNextStageConfig;
  /** 最近一次成功运行的待过目标记；用户过目/归档后清除。recurring 任务记录保持 active，靠它进待审收件箱。 */
  pendingReview?: { resultSessionId?: string; at: number };
  /** B4：本 automation 上人工铸造的 target 粒度长期授权规则。删/archive 即失效（消费时按 status 钳制）。 */
  standingGrants?: StandingGrant[];
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
