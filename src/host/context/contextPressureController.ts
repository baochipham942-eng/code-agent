// ============================================================================
// ContextPressureController — single decision point for context pressure
// (P2-full / G11 / G12)
// ============================================================================
//
// CompressionPipeline owns the non-destructive projection in messageBuild.
// This controller combines its `autocompact-needed` signal with absolute and
// percentage thresholds, then routes execution to CompactionService through
// checkAndAutoCompress. One assessContextPressure() call keeps trigger logic
// in one place.
// ============================================================================

export type PressureTrigger =
  | 'none'
  | 'token-threshold'
  | 'usage-percent'
  | 'pipeline-signal'
  | 'provider-overflow';

export interface CompressionDecision {
  action: 'none' | 'execute' | 'checkpoint-rebuild';
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
  /** Roadmap 3.4: when true, pressure should prefer checkpoint rebuild over pure summary compression. */
  checkpointRebuildAvailable?: boolean;
  checkpointRebuildAlreadyInserted?: boolean;
  isMainAgent?: boolean;
  /**
   * AutoContextCompressor 是否启用。**只 gate 百分比 warning 触发** —— 绝对 token
   * 硬阈值和 pipeline 信号属于"必须压"语义（再不压就要溢出 / 已溢出），不受此开关
   * 影响，与重构前的行为一致。
   */
  compressionEnabled: boolean;
  /**
   * provider 已经返回了 context overflow 错误。
   *
   * 这是**最硬的证据**，优先级高于本文件里其它一切判据：其它三个触发器都建立在
   * 我方的 token 估算之上，而 provider 报溢出恰恰说明那个估算已经被证伪了
   * （估算说没满、真实已经满）。此时再拿同一个估算去过阈值，得到的 `none` 是
   * 用一个已知错误的数做出的决定 —— 压缩会整个跳过，调用方却以为压过了。
   */
  providerConfirmedOverflow?: boolean;
}

/**
 * 单一的上下文压力评估。所有压缩触发决策都应走这里，而不是各自内联判断。
 * 优先级：pipeline 信号 > 绝对 token 阈值 > 百分比 warning 阈值。
 */
export function assessContextPressure(input: PressureInput): CompressionDecision {
  const pressureAction = (): CompressionDecision['action'] => (
    input.checkpointRebuildAvailable
    && !input.checkpointRebuildAlreadyInserted
    && input.isMainAgent !== false
      ? 'checkpoint-rebuild'
      : 'execute'
  );

  // 0. provider 已确认溢出 —— 不看任何估算，无条件压。见 PressureInput 的字段注释。
  if (input.providerConfirmedOverflow) {
    return {
      action: pressureAction(),
      trigger: 'provider-overflow',
      reason: 'provider returned a context overflow error — local token estimate is already falsified',
    };
  }
  // 1. Pipeline 已投影出 ≥85% 压力 —— 此前这个信号只被 log/trace（G12），现在真正进入决策。
  if (input.pipelineAutocompactNeeded) {
    return {
      action: pressureAction(),
      trigger: 'pipeline-signal',
      reason: 'CompressionPipeline reported autocompact-needed (projected usage ≥ 85%)',
    };
  }
  // 2. 绝对 token 阈值（Claude Code 风格）—— 必须压，不受 compressionEnabled 影响。
  if (input.tokenThresholdHit) {
    return {
      action: pressureAction(),
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
      action: pressureAction(),
      trigger: 'usage-percent',
      reason: `usage at ${(input.usageRatio * 100).toFixed(1)}% (warning threshold ${(input.warningThreshold * 100).toFixed(0)}%)`,
    };
  }
  return { action: 'none', trigger: 'none', reason: 'no context pressure detected' };
}
