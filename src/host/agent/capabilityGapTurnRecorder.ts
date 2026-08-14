// ============================================================================
// 缺口探测器的接线点（N-CAP1 / F1）—— agent loop 收尾后调用一次
// ============================================================================
// 单独一个文件，是为了不再往 agentOrchestrator 这个胖文件里加逻辑。
// 全程 fire-and-forget + 吞错：探测器是旁路记账，任何失败都不许影响会话。

import { getComboRecorder } from '../services/skills/comboRecorder';
import { observeTurn } from '../services/skills/capabilityGapDetector';
import { getCapabilityCandidateStore } from '../services/skills/capabilityCandidateStore';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CapabilityGapTurnRecorder');

/**
 * 本轮 token 用量：把 turn_cost_estimates 里落在本轮时间窗内的模型轮次加起来。
 * （一次用户请求 = N 个模型轮，账本按模型轮记，所以要按时间窗归并。）
 * 拿不到就返回 0——探测器会退化成纯步数成本，不假装有数据。
 */
async function turnTokensSince(sessionId: string, sinceMs: number): Promise<number> {
  try {
    // 动态 import：探测器在没有数据库的单测/CLI 场景下也要能跑
    const { getDatabase } = await import('../services/core/databaseService');
    return getDatabase()
      .getTurnCostRepo()
      .listBySession(sessionId)
      .filter((row) => row.createdAt >= sinceMs)
      .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  } catch {
    return 0;
  }
}

export async function recordCapabilityGapTurn(sessionId: string): Promise<void> {
  try {
    const recording = getComboRecorder().getRecording(sessionId);
    const turn = recording?.turns[recording.turns.length - 1];
    if (!turn) return;

    await getCapabilityCandidateStore().load();
    observeTurn(
      {
        userMessage: turn.userMessage,
        steps: turn.steps,
        tokens: await turnTokensSince(sessionId, turn.timestamp),
      },
      Date.now(),
    );
  } catch (error) {
    logger.debug('候选能力记账跳过', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
