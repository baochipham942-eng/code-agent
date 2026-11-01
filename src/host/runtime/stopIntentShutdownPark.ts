// ============================================================================
// stopIntentShutdownPark — 「停止并退出」停机时给在跑的主 run 落可恢复终态（FB-324）
// ============================================================================
// 背景：壳选「停止并退出」→ POST /api/quit-intent{stop} → SIGTERM →
// webServer.shutdown() 的排空/收尸步骤都不触碰 runRegistry 里的主 run；
// run 的终态于是由 SSE 断开取消路径随机落笔（failed + 空 assistant），重开后
// session.durableResume 为 null——用户看到的是「只有提问、没有回答、也没有
// 中断/继续入口」的半截会话。
// 修复：stop 意图停机时，在排空之后、关库之前，把每个在跑的主 run 按停止按钮
// 同款路径收口——finalizeOrParkDurableRun(cancelled)：有原生恢复描述符的停靠成
// waiting+user_stop（重开出现继续提示），没有的落终态 cancelled（重开出现中断）。
// 非 stop 意图（none/background）不改任何行为。
// ============================================================================

import type { RunRegistry } from './runRegistry';
import { finalizeOrParkDurableRun } from '../agent/orchestrator/durableRunTerminal';
import { getDaemonQuitIntent } from '../services/daemon/quitIntent';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('StopIntentShutdownPark');

export interface StopIntentShutdownParkSummary {
  intent: string;
  /** 停靠成 waiting+user_stop 的主 run 数（重开出现继续提示）。 */
  parked: number;
  /** 无恢复描述符、落终态 cancelled 的 run 数（重开出现中断线）。 */
  terminalCancelled: number;
  /** 不属于主 run 收口范围而跳过的 handle 数（子 run / 外部 CLI run / 无 durable owner）。 */
  skipped: number;
  /** 收口步骤抛错（已 warn 留痕）的 run 数。 */
  errors: number;
}

/**
 * 只在 stop 意图下动作；每个 run 的兜底 terminal（cancelled）与停止按钮共用
 * finalizeOrParkDurableRun 的缺省实现。进程随后即退，这里不再 cancel 运行循环。
 */
export async function parkPrimaryRunsOnStopIntentShutdown(registry: RunRegistry): Promise<StopIntentShutdownParkSummary> {
  const intent = getDaemonQuitIntent();
  const summary: StopIntentShutdownParkSummary = { intent, parked: 0, terminalCancelled: 0, skipped: 0, errors: 0 };
  if (intent !== 'stop') return summary;
  for (const handle of registry.list()) {
    const runId = handle.context.runId;
    // 只收口「有 durable owner 的原生主 run」：
    //  - 无 owner（startAuxiliary 的浏览器/子任务 handle）：没有 durable 行可收，硬收只会白报错；
    //  - 有 parentRunId 的 agent-team 子 run：停成 waiting 没有继续入口，父 run 的 agent-team:<child>
    //    pending op 也等不到终态（durableRunTerminal.canParkResumableUserStop 同口径）；
    //    它们随父 run 的终态/停靠与 spawnGuard.cancelAll 一并收尾；
    //  - external_cli 引擎 run：终态由 externalLifecycle.finish 收口，这里写 cancelled 会绕过它。
    const envelope = registry.getDurableEnvelope(runId);
    if (!registry.hasDurableOwner(runId) || !envelope || envelope.parentRunId || envelope.engine?.kind === 'external_cli') {
      summary.skipped += 1;
      continue;
    }
    try {
      await finalizeOrParkDurableRun({
        registry,
        runId,
        handle,
        sessionId: handle.context.sessionId,
        completed: false,
        cancelled: true,
        registration: 'primary',
      });
      if (!registry.hasDurableOwner(runId)) summary.terminalCancelled += 1;
      else {
        summary.parked += 1;
        // 立刻交出租约：停靠行的租约默认还有一段余量，重开太快会撞在窗口里，
        // listParkedForReclaim 认不出（lease_expires_at<=now），会话仍是半截状态。
        await registry.releaseDurable(runId);
      }
    } catch (error) {
      summary.errors += 1;
      logger.warn('Failed to park/terminal a durable run during stop-intent shutdown', {
        runId,
        sessionId: handle.context.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
