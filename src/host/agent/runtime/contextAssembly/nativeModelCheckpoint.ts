import { createHash } from 'node:crypto';
import type { ModelConfig } from '../../../../shared/contract/model';
import { getConfiguredApplicationRunRegistry } from '../../../app/applicationRunRegistry';
import type { ContextAssemblyCtx } from './shared';

export async function checkpointNativeModel(
  ctx: ContextAssemblyCtx,
  config: ModelConfig,
  phase: 'before_model_dispatch' | 'after_model_dispatch',
  status: 'prepared' | 'dispatched' | 'succeeded',
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
    logicalOperationId: ctx.runtime.currentTurnId,
    phase,
    status,
    ...(status === 'succeeded' ? {
      resultRef: `model-result:${createHash('sha256')
        .update(`${runId}:${ctx.runtime.currentTurnId}:${config.provider}:${config.model}`)
        .digest('hex')}`,
    } : {}),
  });
}
