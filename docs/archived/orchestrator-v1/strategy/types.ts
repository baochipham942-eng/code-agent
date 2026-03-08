// ============================================================================
// Strategy Types - 策略演进系统类型定义
// ============================================================================

/**
 * 策略类型
 */
export type StrategyType =
  | 'routing' // 路由策略
  | 'execution' // 执行策略
  | 'tool_selection' // 工具选择策略
  | 'agent_selection' // Agent 选择策略
  | 'error_handling'; // 错误处理策略

/**
 * 策略来源
 */
export type StrategySource = 'local' | 'cloud' | 'learned' | 'default';

/**
 * 策略状态
 */
export type StrategyStatus = 'active' | 'testing' | 'deprecated' | 'disabled';

/**
 * 策略规则
 */
export interface StrategyRule {
  id: string;
  condition: RuleCondition;
  action: RuleAction;
  priority: number;
  weight: number;
}

/**
 * 规则条件
 */
export interface RuleCondition {
  type: 'keyword' | 'pattern' | 'capability' | 'context' | 'composite';
  operator: 'contains' | 'matches' | 'equals' | 'gt' | 'lt' | 'in' | 'and' | 'or' | 'not';
  value: unknown;
  field?: string;
  children?: RuleCondition[];
}

/**
 * 规则动作
 */
export interface RuleAction {
  type: 'route' | 'select_tool' | 'select_agent' | 'set_param' | 'transform';
  target?: string;
  params?: Record<string, unknown>;
}

/**
 * 策略定义
 */
export interface Strategy {
  id: string;
  name: string;
  description: string;
  type: StrategyType;
  source: StrategySource;
  status: StrategyStatus;
  version: number;
  rules: StrategyRule[];
  metadata: StrategyMetadata;
  createdAt: string;
  updatedAt: string;
}

/**
 * 策略元数据
 */
export interface StrategyMetadata {
  author?: string;
  tags?: string[];
  applicability?: {
    taskTypes?: string[];
    projectTypes?: string[];
    languages?: string[];
  };
  performance?: StrategyPerformance;
}

/**
 * 策略性能统计
 */
export interface StrategyPerformance {
  usageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageLatency: number;
  lastUsedAt?: string;
}

/**
 * 策略评估结果
 */
export interface StrategyEvaluation {
  strategyId: string;
  taskId: string;
  matched: boolean;
  matchedRules: string[];
  confidence: number;
  suggestedAction?: RuleAction;
  evaluatedAt: string;
}

/**
 * 策略同步请求
 */
export interface StrategySyncRequest {
  userId: string;
  localStrategies: Strategy[];
  lastSyncAt?: string;
  includeGlobal?: boolean;
}

/**
 * 策略同步响应
 */
export interface StrategySyncResponse {
  success: boolean;
  strategies: Strategy[];
  globalStrategies?: Strategy[];
  conflicts?: StrategyConflict[];
  syncedAt: string;
}

/**
 * 策略冲突
 */
export interface StrategyConflict {
  strategyId: string;
  localVersion: number;
  remoteVersion: number;
  conflictType: 'update' | 'delete' | 'create';
  resolution?: 'local' | 'remote' | 'merge';
}

/**
 * 学习反馈
 */
export interface LearningFeedback {
  id: string;
  userId: string;
  taskId: string;
  strategyId?: string;
  feedback: {
    type: 'positive' | 'negative' | 'neutral';
    rating?: number;
    comment?: string;
    correction?: RuleAction;
  };
  context: {
    prompt: string;
    appliedRules: string[];
    result: unknown;
  };
  createdAt: string;
}

/**
 * 学习结果
 */
export interface LearningResult {
  feedbackId: string;
  processedAt: string;
  strategyUpdates?: StrategyUpdate[];
  newRules?: StrategyRule[];
  confidenceChange?: number;
}

/**
 * 策略更新
 */
export interface StrategyUpdate {
  strategyId: string;
  ruleId?: string;
  updateType: 'weight_adjust' | 'priority_adjust' | 'rule_modify' | 'rule_add' | 'rule_remove';
  before?: unknown;
  after?: unknown;
  reason: string;
}

/**
 * 策略配置
 */
export interface StrategyConfig {
  enableLearning: boolean;
  syncInterval: number;
  maxLocalStrategies: number;
  autoActivateThreshold: number;
  conflictResolution: 'local' | 'remote' | 'manual';
  shareAnonymously: boolean;
}

/**
 * 跨用户学习配置
 */
export interface CrossUserLearningConfig {
  enabled: boolean;
  minFeedbackCount: number;
  minSuccessRate: number;
  privacyLevel: 'none' | 'anonymous' | 'aggregated';
  categories: string[];
}

/**
 * 聚合策略统计
 */
export interface AggregatedStrategyStats {
  strategyId: string;
  totalUsage: number;
  userCount: number;
  successRate: number;
  averageRating: number;
  topUseCases: string[];
  updatedAt: string;
}
