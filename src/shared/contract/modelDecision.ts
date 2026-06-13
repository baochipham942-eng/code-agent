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
  | 'strategy-fast'
  | 'strategy-main'
  | 'strategy-deep'
  | 'strategy-vision'
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
  /** 任务策略 profile。为空表示沿用 legacy 用户选择 / 角色档位路径。 */
  strategyProfile?: 'fast' | 'main' | 'deep' | 'vision';
  /** 命中的任务策略规则 ID。 */
  strategyRuleId?: string;
  /** 给 UI/Replay 展示的策略解释。 */
  strategyReason?: string;
  taskComplexity?: {
    level: 'simple' | 'moderate' | 'complex';
    score: number;
    signals: string[];
  };
}

export interface ModelDecisionEventData extends ModelDecision {
  turnId?: string;
  timestamp?: number;
}
