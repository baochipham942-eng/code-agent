// ============================================================================
// Model Decision Contract - shared event payload for ADR-019 routing trace.
// ============================================================================

/** Provider 计费方式（ADR-019 决策 4：计费语义四分类） */
export type BillingMode = 'free' | 'plan' | 'payg' | 'unknown';

/** 决策原因，UI trace 文案和日志都从这里派生 */
export type ModelDecisionReason =
  | 'user-selected'
  | 'role-tier'
  | 'simple-task-free'
  | 'billing-gate-skip'
  | 'capability-vision'
  | 'fallback-availability';

/** 结构化路由决策，main / renderer / telemetry 共用 */
export interface ModelDecision {
  requestedProvider: string;
  requestedModel: string;
  resolvedProvider: string;
  resolvedModel: string;
  /** subagent 角色（explore/coder 等），主聊天为 null */
  role: string | null;
  reason: ModelDecisionReason;
  billingMode: BillingMode;
  /** 可用性降级时记录降级前的模型，其余为 null */
  fallbackFrom: string | null;
}

export interface ModelDecisionEventData extends ModelDecision {
  turnId?: string;
  timestamp?: number;
}
