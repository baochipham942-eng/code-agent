import type { AgentEvent, Message } from '../../../shared/contract';
import { generateMessageId } from '../../../shared/utils/id';
import { CompressionState } from '../compressionState';
import { getContextEventLedger } from '../contextEventLedger';
import { estimateTokens } from '../tokenOptimizer';
import {
  readExistingCheckpointStore,
  resolveCheckpointStorePaths,
} from './store';
import {
  buildRebuildTailContext,
  renderCheckpointRebuildContext,
} from './rebuild';
import { validateCheckpointDocument } from './validator';

export interface CheckpointBoundaryRuntime {
  sessionId: string;
  agentId?: string;
  workingDirectory: string;
  messages: Message[];
  onEvent: (event: AgentEvent) => void;
  persistMessage?: (message: Message) => Promise<void>;
  compressionState: CompressionState;
  checkpointRebuildLastWatermarkId?: string;
  checkpointRootDir?: string;
}

export interface CheckpointBoundaryResult {
  inserted: boolean;
  reason: string;
  markerMessageId?: string;
  compactedMessageCount?: number;
  compactedTokenCount?: number;
  boundaryMessageId?: string | null;
}

function checkpointHasIntent(checkpoint: string): boolean {
  const validation = validateCheckpointDocument(checkpoint);
  return validation.missingSections.length === 0 && validation.activeIntentHasVerbatimQuote;
}

function currentWatermark(messages: readonly Message[]): string | undefined {
  return messages.at(-1)?.id;
}

async function persistBoundaryMessage(runtime: CheckpointBoundaryRuntime, message: Message): Promise<void> {
  if (runtime.persistMessage) {
    try {
      await runtime.persistMessage(message);
      return;
    } catch {
      // Fall through to the session manager fallback, mirroring compaction markers.
    }
  }
  if (runtime.sessionId) {
    const { getSessionManager } = await import('../../services');
    await getSessionManager().addMessageToSession(runtime.sessionId, message);
  }
}

export async function tryInsertCheckpointRebuildBoundary(
  runtime: CheckpointBoundaryRuntime,
): Promise<CheckpointBoundaryResult> {
  if (runtime.agentId) {
    return { inserted: false, reason: 'subagent-runtime' };
  }
  const watermark = currentWatermark(runtime.messages);
  if (!watermark) {
    return { inserted: false, reason: 'no-watermark' };
  }
  if (runtime.checkpointRebuildLastWatermarkId === watermark) {
    return { inserted: false, reason: 'same-watermark' };
  }

  const paths = resolveCheckpointStorePaths({
    sessionId: runtime.sessionId,
    workingDirectory: runtime.workingDirectory,
    rootDir: runtime.checkpointRootDir,
  });
  const artifacts = await readExistingCheckpointStore(paths);
  if (!artifacts || !checkpointHasIntent(artifacts.checkpoint)) {
    return { inserted: false, reason: 'no-usable-checkpoint' };
  }

  const tail = buildRebuildTailContext(runtime.messages);
  if (tail.compactedMessageCount <= 0) {
    return { inserted: false, reason: 'tail-already-full-history' };
  }

  const content = renderCheckpointRebuildContext({
    checkpoint: artifacts.checkpoint,
    memory: artifacts.memory,
    notes: artifacts.notes,
    tailMessages: tail.tailMessages,
  });
  const compactedTokenCount = runtime.messages
    .slice(0, tail.compactedMessageCount)
    .reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
  const marker: Message = {
    id: generateMessageId(),
    role: 'system',
    content,
    timestamp: Date.now(),
    isMeta: true,
    source: 'system',
  };

  runtime.messages.splice(0, tail.compactedMessageCount, marker);
  runtime.checkpointRebuildLastWatermarkId = watermark;
  runtime.compressionState = new CompressionState();
  runtime.compressionState.applyCommit({
    layer: 'system',
    operation: 'reset',
    targetMessageIds: [marker.id],
    timestamp: marker.timestamp,
    metadata: {
      kind: 'checkpoint_rebuild_boundary',
      boundaryMessageId: tail.boundaryMessageId,
      compactedMessageCount: tail.compactedMessageCount,
      compactedTokenCount,
    },
  });
  getContextEventLedger().upsertEvents([{
    id: '',
    sessionId: runtime.sessionId,
    agentId: runtime.agentId,
    messageId: marker.id,
    category: 'compression_survivor',
    action: 'compressed',
    sourceKind: 'compression_survivor',
    sourceDetail: 'checkpoint:rebuild_boundary',
    layer: 'system',
    reason: 'checkpoint rebuild boundary inserted before pure autocompact',
    timestamp: marker.timestamp,
  }]);
  await persistBoundaryMessage(runtime, marker);
  runtime.onEvent({
    type: 'context_compressed',
    data: {
      savedTokens: compactedTokenCount,
      strategy: 'checkpoint_rebuild_boundary',
      newMessageCount: runtime.messages.length,
    },
  } as AgentEvent);

  return {
    inserted: true,
    reason: 'inserted',
    markerMessageId: marker.id,
    compactedMessageCount: tail.compactedMessageCount,
    compactedTokenCount,
    boundaryMessageId: tail.boundaryMessageId,
  };
}
