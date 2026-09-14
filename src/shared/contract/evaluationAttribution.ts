// ============================================================================
// 归因码本共享契约（ADR-071 D2/D4）
// ----------------------------------------------------------------------------
// 两个来源分得开，不混算：
//   · 默认归因 = failcodes.yaml 上的 `attribution:`，是「这个 failcode 通常是谁的
//     错」的统计先验，不是这一题的判断（ADR-071 Q5：不进任何聚合口径）。
//   · 人工归因 = 抽屉里人填的三件套，落 annotations.attribution_json。
// 从 evaluation.ts 拆出来单独成文件（那份已顶到 max-lines 上限，见 evaluationHarvest.ts
// 同一条理由）；消费方仍从 '@shared/contract/evaluation' 取。
// ============================================================================

/** 四类归因（课程语言：归因即路由）。 */
export const EVAL_ATTRIBUTIONS = [
  'user_input',
  'model_capability',
  'scenario_fit',
  'system_config',
] as const;
export type EvalAttribution = (typeof EVAL_ATTRIBUTIONS)[number];

/** 风险定级 P0~P3（ADR-071 D3）。 */
export const EVAL_SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type EvalSeverity = (typeof EVAL_SEVERITIES)[number];

export function isEvalAttribution(value: unknown): value is EvalAttribution {
  return typeof value === 'string' && (EVAL_ATTRIBUTIONS as readonly string[]).includes(value);
}

export function isEvalSeverity(value: unknown): value is EvalSeverity {
  return typeof value === 'string' && (EVAL_SEVERITIES as readonly string[]).includes(value);
}

/**
 * 人工归因三件套 + 定级。归因三原则（只下初步判断 / 留证据 / 可复现）里的「留证据」
 * 就是 evidence 这一格，所以它与 attribution 一样必填。
 */
export interface EvalAttributionTriple {
  attribution: EvalAttribution;
  /** 证据：引用输出或工具调用，一句话。 */
  evidence: string;
  /** 建议：可执行动作。 */
  suggestion?: string;
  severity: EvalSeverity;
}

/** 归因为这两类且定级 P0/P1 = 真缺陷，走反馈池（ADR-071 D5）。 */
export function isFeedbackPoolCandidate(triple: EvalAttributionTriple): boolean {
  return (triple.attribution === 'scenario_fit' || triple.attribution === 'system_config')
    && (triple.severity === 'P0' || triple.severity === 'P1');
}

export interface EvalFeedbackPushRequest {
  experimentId: string;
  caseId: string;
  /** 本题的失败原因原文，作为证据的一部分。 */
  failureReason?: string;
  triple: EvalAttributionTriple;
}

export interface EvalFeedbackPushResult {
  /** 证据落盘目录（无论有没有配钩子命令都会写）。 */
  evidenceDir: string;
  /** 配了 settings.evaluation.feedbackHookCommand 才会执行。 */
  hookRan: boolean;
  /** 钩子命令的输出尾巴，供 toast 回显。 */
  output?: string;
}
