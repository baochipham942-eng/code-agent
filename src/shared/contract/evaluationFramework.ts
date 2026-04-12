// ============================================================================
// Evaluation Framework Types - ExcelMaster-inspired Eval Framework
// Split from evaluation.ts for maintainability
// ============================================================================

// ============================================================================
// ExcelMaster-inspired Eval Framework Types
// ============================================================================

/** 评分维度配置（映射自 ExcelMaster 9 维度） */
export interface ScoringDimensionConfig {
  name: EvalDimensionName;
  weight: number;           // 0-1, all weights sum to 1
  graderType: 'code' | 'llm' | 'rule';
  enabled: boolean;
  description: string;
}

export type EvalDimensionName =
  | 'task_completion'       // 30% - tsc + test + golden diff
  | 'code_quality'          // 15% - LLM judge
  | 'task_understanding'    // 15% - LLM judge
  | 'workflow_compliance'   // 10% - Rule: read-before-edit
  | 'verification'          // 10% - Rule: did it verify?
  | 'plan_quality'          // 5%  - LLM judge
  | 'tool_selection'        // 5%  - Rule + LLM
  | 'self_repair'           // 5%  - Rule
  | 'efficiency';           // 5%  - Rule

export const DEFAULT_SCORING_CONFIG: ScoringDimensionConfig[] = [
  { name: 'task_completion', weight: 0.30, graderType: 'code', enabled: true, description: '任务完成度（确定性验证）' },
  { name: 'code_quality', weight: 0.15, graderType: 'llm', enabled: true, description: '代码质量' },
  { name: 'task_understanding', weight: 0.15, graderType: 'llm', enabled: true, description: '需求理解' },
  { name: 'workflow_compliance', weight: 0.10, graderType: 'rule', enabled: true, description: '工作流规范' },
  { name: 'verification', weight: 0.10, graderType: 'rule', enabled: true, description: '验证行为' },
  { name: 'plan_quality', weight: 0.05, graderType: 'llm', enabled: true, description: '方案质量' },
  { name: 'tool_selection', weight: 0.05, graderType: 'rule', enabled: true, description: '工具选择' },
  { name: 'self_repair', weight: 0.05, graderType: 'rule', enabled: true, description: '自修复能力' },
  { name: 'efficiency', weight: 0.05, graderType: 'rule', enabled: true, description: '效率（Token/时间）' },
];

/** Failure Funnel 5 阶段 */
export type FailureStage =
  | 'security_guard'        // Stage 1: Forbidden patterns
  | 'compilation_check'     // Stage 2: tsc/eslint
  | 'self_repair_check'     // Stage 3: Error recovery
  | 'outcome_verification'  // Stage 4: Golden state comparison
  | 'llm_scoring';          // Stage 5: Swiss Cheese LLM judge

export interface FailureFunnelResult {
  stage: FailureStage;
  passed: boolean;
  blockedCount: number;
  details: string[];
}

/** 确定性验证器类型 */
export type VerifierType = 'tsc' | 'eslint' | 'test' | 'diff' | 'forbidden' | 'syntax';

export interface VerifierResult {
  type: VerifierType;
  passed: boolean;
  output?: string;
  durationMs: number;
}

/** 测试集层级 */
export type TestSetTier = 'smoke' | 'core' | 'full' | 'benchmark';

/** 测试用例来源 */
export type TestCaseSource = 'swe-bench' | 'aider' | 'production-trace' | 'manual' | 'regression';

/** 维度得分（单个） */
export interface DimensionScore {
  dimension: EvalDimensionName;
  score: number;  // 0-1
  graderType: 'code' | 'llm' | 'rule';
  reasoning?: string;
  evidence?: string;
}

/** 实验摘要（用于前端实验列表） */
export interface ExperimentSummary {
  id: string;
  appVersion: string;
  gitCommit: string;
  tag: TestSetTier;
  model: string;
  testSetId: string;
  trialsPerCase: number;
  status: 'running' | 'completed' | 'cancelled';
  totalCases: number;
  passedCases: number;
  failedCases: number;
  partialCases: number;
  passRate: number;
  avgScore: number;
  unstableCaseCount: number;
  totalTokens: number;
  totalDurationMs: number;
  createdAt: string;
  completedAt?: string;
}
