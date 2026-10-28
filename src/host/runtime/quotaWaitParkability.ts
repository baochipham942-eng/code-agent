import type { RunRegistry } from './runRegistry';
import { isNativeRecoveryDescriptor } from './nativeRecoveryHost';

/**
 * quota 挂起的可停靠判据，与停靠收口（durableRunTerminal.canParkResumableUserStop）同源：
 * 无父 run 的主 durable run，且 checkpoint 已是 native descriptor（Continue 接得回来）。
 * 辅助子 run（带 parentRunId）、无 descriptor、非持久会话都不可挂起——它们的额度等待
 * 必须留在原重试/降级链里，否则会静默取消、任务凭空死掉（rework r1 Important）。
 */
export function isQuotaWaitParkableRun(
  registry: RunRegistry | null | undefined,
  runId: string | undefined,
): boolean {
  if (!registry || !runId) return false;
  if (!registry.hasDurableOwner(runId)) return false;
  // 这是挂在 applicationRunRegistry 缝隙上的探测，测试会用最小假件替身整个 registry；
  // 缺 envelope/checkpoint 访问器 = 不可停靠，按 false 走原封顶重试。探测绝不能把
  // TypeError 抛进模型调用主路径，顶替模型的真实结果/错误（nativeModelCheckpoint
  // 的 checkpoint 降级同款纪律）。
  if (typeof registry.getDurableEnvelope !== 'function') return false;
  if (typeof registry.getDurableCheckpointState !== 'function') return false;
  const envelope = registry.getDurableEnvelope(runId);
  if (!envelope || envelope.parentRunId) return false;
  return isNativeRecoveryDescriptor(registry.getDurableCheckpointState(runId));
}
