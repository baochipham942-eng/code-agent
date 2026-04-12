// ============================================================================
// LearningPipeline — Session-end learning, pattern extraction, error learning
// Extracted from AgentLoop (all methods are no-ops after Memory service removal)
// ============================================================================

import type { AgentEvent } from '../../../shared/contract';
import type { RuntimeContext } from './runtimeContext';

export class LearningPipeline {
  constructor(protected ctx: RuntimeContext) {}

  // Convenience: emit event through context
  protected onEvent(event: AgentEvent): void {
    this.ctx.onEvent(event);
  }

  async runSessionEndLearning(): Promise<void> {
    // Memory service removed — no-op
    return;
  }

  /**
   * 持续学习：从会话中提取模式并建立实体关系
   */

  async runContinuousLearning(): Promise<void> {
    // Memory service removed — no-op
    return;
  }

  /**
   * 从会话中提取错误模式并学习
   */

  async runErrorPatternLearning(): Promise<void> {
    // Memory service removed — no-op
    return;
  }
}
