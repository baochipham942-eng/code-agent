import { createHash } from 'node:crypto';
import type { ModelConfig } from '../../../../shared/contract/model';
import { getConfiguredApplicationRunRegistry } from '../../../app/applicationRunRegistry';
import { logger, type ContextAssemblyCtx } from './shared';

export async function checkpointNativeModel(
  ctx: ContextAssemblyCtx,
  config: ModelConfig,
  phase: 'before_model_dispatch' | 'after_model_dispatch',
  status: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'abandoned',
): Promise<void> {
  const runId = ctx.runtime.runId;
  const registry = getConfiguredApplicationRunRegistry();
  if (!runId || !registry?.hasDurableOwner(runId)) return;

  const sourceMessageId = [...ctx.runtime.messages]
    .reverse()
    .find((message) => message.role === 'user')?.id;
  if (!sourceMessageId) {
    throw new Error('Native Durable model checkpoint requires a stable source message id');
  }

  await registry.checkpointNativeModelOperation({
    runId,
    sourceMessageId,
    provider: config.provider,
    model: config.model,
    logicalOperationId: ctx.runtime.turn.currentTurnId,
    phase,
    status,
    isGoalRun: ctx.runtime.goalMode != null,
    ...(status === 'succeeded' ? {
      resultRef: `model-result:${createHash('sha256')
        .update(`${runId}:${ctx.runtime.turn.currentTurnId}:${config.provider}:${config.model}`)
        .digest('hex')}`,
    } : {}),
  });
}

/**
 * 把一次模型调用包在它的 Durable Run 操作生命周期里。
 *
 * 关键是失败那条路：不给终态的话这次调用永远停在 dispatched，而 Durable Run 不允许
 * completed 的轮次里留着未了结的操作——轮次收尾时 assertRunEnvelope 抛
 * 「completed runs cannot contain unresolved operations」，用户看到一张「运行失败」卡，
 * 而这一轮其实答完了（2026-08-01 真机：插队打断长任务后两次都挂着这张卡）。
 *
 * 用户主动打断记 abandoned（不是失败），真出错才记 failed。
 */
export async function withNativeModelOperation<T>(
  ctx: ContextAssemblyCtx,
  config: ModelConfig,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  await checkpointNativeModel(ctx, config, 'before_model_dispatch', 'prepared');
  await checkpointNativeModel(ctx, config, 'after_model_dispatch', 'dispatched');
  let result: T;
  try {
    result = await run();
  } catch (error) {
    const abandonedByUser = ctx.runtime.control.isCancelled
      || ctx.runtime.control.isInterrupted
      || signal.aborted;
    await checkpointNativeModel(
      ctx,
      config,
      'after_model_dispatch',
      abandonedByUser ? 'abandoned' : 'failed',
    ).catch((checkpointError) => {
      logger.warn('[AgentLoop] Failed to settle the native model operation after an inference error:', checkpointError);
    });
    throw error;
  }
  await checkpointNativeModel(ctx, config, 'after_model_dispatch', 'succeeded');
  return result;
}
