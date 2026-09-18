import { SteerRejectedError } from '../../agent/runtime/conversationRuntime';
import type { RunHandle } from '../../runtime/runContext';
import { steerOrQueue, type SteerQueueFenceRepository } from '../../runtime/steerQueueFence';

export async function steerOrQueueCompanionMessage(
  run: RunHandle,
  input: { sessionId: string; commandId: string; text: string },
  repository?: SteerQueueFenceRepository,
): Promise<{ runId: string; outcome: 'steered' | 'queued' }> {
  const outcome = await steerOrQueue({
    steer: async (content, clientMessageId, attachments, metadata, displayContent, expectedTurnId) => {
      if (!run.isAttached || run.cancellationRequested) throw new SteerRejectedError();
      await run.steer(content, clientMessageId, attachments, metadata, displayContent, expectedTurnId);
    },
  }, {
    sessionId: input.sessionId,
    content: input.text,
    clientMessageId: input.commandId,
    metadata: { workbench: { runtimeInputMode: 'supplement' } },
    context: { runtimeInput: { mode: 'supplement' } },
  }, repository);
  return { runId: run.context.runId, outcome: outcome.outcome };
}

export function companionSteerMessagePayload(input: {
  commandId: string;
  text: string;
  runId: string;
  outcome: 'steered' | 'queued';
}): Record<string, unknown> {
  return {
    id: input.commandId,
    role: 'user',
    content: input.text,
    runId: input.runId,
    ...(input.outcome === 'queued' ? { queued: true } : {}),
  };
}
