// ============================================================================
// ContextPressureController — single decision point for context pressure
// (P2-full / G11 / G12)
// ============================================================================
//
// Background: code-agent had two uncoordinated compression entry points —
// CompressionPipeline (non-destructive projection, runs in messageBuild) and
// the AutoContextCompressor path (destructive history rewrite, runs in
// checkAndAutoCompress). They never shared a decision. In particular the
// Pipeline's `autocompact-needed` signal (projected usage ≥ 85%) was reported
// but never fed into the compaction trigger (G12).
//
// This module does NOT merge the two implementations — per the gap-analysis
// convergence they stay as separate strategies. It unifies the *decision*:
// one assessContextPressure() that all callers consult, so the trigger logic
// lives in one place and the Pipeline signal actually participates.
// ============================================================================

export type PressureTrigger =
  | 'none'
  | 'token-threshold'
  | 'usage-percent'
  | 'pipeline-signal';

export interface CompressionDecision {
  action: 'none' | 'execute';
  trigger: PressureTrigger;
  reason: string;
}

export interface PressureInput {
  /** 当前消息历史的 raw token 估算 */
  currentTokens: number;
  /** AutoContextCompressor 的绝对 token 阈值是否命中 */
  tokenThresholdHit: boolean;
  /** context health 的使用率 (0-1)，无 health 数据时 undefined */
  usageRatio?: number;
  /** AutoContextCompressor 配置的百分比 warning 阈值 (0-1) */
  warningThreshold: number;
  /** 本 turn 内 CompressionPipeline 是否报告了 autocompact-needed（投影使用率 ≥ 85%） */
  pipelineAutocompactNeeded?: boolean;
  /**
   * AutoContextCompressor 是否启用。**只 gate 百分比 warning 触发** —— 绝对 token
   * 硬阈值和 pipeline 信号属于"必须压"语义（再不压就要溢出 / 已溢出），不受此开关
   * 影响，与重构前的行为一致。
   */
  compressionEnabled: boolean;
}

/**
 * 单一的上下文压力评估。所有压缩触发决策都应走这里，而不是各自内联判断。
 * 优先级：pipeline 信号 > 绝对 token 阈值 > 百分比 warning 阈值。
 */
export function assessContextPressure(input: PressureInput): CompressionDecision {
  // 1. Pipeline 已投影出 ≥85% 压力 —— 此前这个信号只被 log/trace（G12），现在真正进入决策。
  if (input.pipelineAutocompactNeeded) {
    return {
      action: 'execute',
      trigger: 'pipeline-signal',
      reason: 'CompressionPipeline reported autocompact-needed (projected usage ≥ 85%)',
    };
  }
  // 2. 绝对 token 阈值（Claude Code 风格）—— 必须压，不受 compressionEnabled 影响。
  if (input.tokenThresholdHit) {
    return {
      action: 'execute',
      trigger: 'token-threshold',
      reason: `absolute token threshold reached (${input.currentTokens} tokens)`,
    };
  }
  // 3. 百分比 warning 阈值 fallback —— 软触发，受 compressionEnabled gate。
  if (
    input.compressionEnabled
    && input.usageRatio !== undefined
    && input.usageRatio >= input.warningThreshold
  ) {
    return {
      action: 'execute',
      trigger: 'usage-percent',
      reason: `usage at ${(input.usageRatio * 100).toFixed(1)}% (warning threshold ${(input.warningThreshold * 100).toFixed(0)}%)`,
    };
  }
  return { action: 'none', trigger: 'none', reason: 'no context pressure detected' };
}
