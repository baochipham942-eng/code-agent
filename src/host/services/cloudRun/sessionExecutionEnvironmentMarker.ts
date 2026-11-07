// ============================================================================
// sessionExecutionEnvironmentMarker — 会话级「跑过云」标记的写侧（ADR-081/087 S4B）
// ============================================================================
// 标记粘性：本模块只写不清——之后的本地回合不移除它，也没有任何清除路径。
// 读侧唯一入口是 shared 合约的 readPersistedExecutionEnvironment。
// 等值跳过：同一 environmentId 重复 admit 不重写，避免每轮 bump updated_at。
// ============================================================================

import {
  EXECUTION_ENVIRONMENT_METADATA_KEY,
  readPersistedExecutionEnvironment,
} from '../../../shared/contract/executionEnvironmentMarker';

export interface SessionExecutionEnvironmentMarkDeps {
  /** 读当前 metadata（判等用）；读不到视为无 marker。 */
  readSessionMetadata: (sessionId: string) => Promise<Record<string, unknown> | undefined>;
  /** key 级原子补丁；false = 会话行不存在。 */
  patchSessionMetadata: (sessionId: string, patch: Record<string, unknown>) => Promise<boolean>;
  logger: { warn: (message: string, data?: unknown) => void };
}

/**
 * 返回的函数永不 throw：patch 返回 false（会话行还不存在）只 warn，
 * patch 抛异常只 warn——调用方（admit / run 启动重试）的失败路径不受影响。
 */
export function createMarkSessionExecutionEnvironment(
  deps: SessionExecutionEnvironmentMarkDeps,
): (sessionId: string, environmentId: string) => Promise<boolean> {
  return async (sessionId: string, environmentId: string): Promise<boolean> => {
    try {
      const current = readPersistedExecutionEnvironment(await deps.readSessionMetadata(sessionId));
      if (current?.environmentId === environmentId) return true;
      const patched = await deps.patchSessionMetadata(sessionId, {
        [EXECUTION_ENVIRONMENT_METADATA_KEY]: { kind: 'cloud', environmentId, setAt: Date.now() },
      });
      if (!patched) {
        deps.logger.warn('[CloudRun] execution environment marker not written: session row missing', {
          sessionId,
          environmentId,
        });
      }
      return patched;
    } catch (error) {
      deps.logger.warn('[CloudRun] execution environment marker patch threw', {
        sessionId,
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };
}
