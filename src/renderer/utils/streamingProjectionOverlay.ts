import type { Message } from '@shared/contract';
import type { TraceNode, TraceProjection, TraceTurn } from '@shared/contract/trace';
import type { StreamingMessageDelta } from '../stores/streamingMessageAccumulatorStore';
import { measureStreamingPerformanceTiming } from './streamingPerformanceMetrics';

export function applyStreamingMessageDeltasToProjection(
  projection: TraceProjection,
  messages: Message[],
  entries: Record<string, StreamingMessageDelta>,
): TraceProjection {
  return measureStreamingPerformanceTiming('stream.projection.overlay_ms', () => {
  const activeEntries = Object.entries(entries).filter(([, entry]) =>
    Boolean(entry.contentDelta || entry.reasoningDelta)
  );
  if (activeEntries.length === 0 || projection.turns.length === 0) {
    return projection;
  }

  let turns = projection.turns;
  let changed = false;

  for (const [messageId, entry] of activeEntries) {
    const nodeId = getAssistantTextNodeId(messageId);
    let foundExistingNode = false;

    const nextTurns = turns.map((turn) => {
      const nodeIndex = turn.nodes.findIndex((node) =>
        node.type === 'assistant_text' && node.id === nodeId
      );
      if (nodeIndex < 0) {
        return turn;
      }

      foundExistingNode = true;
      changed = true;
      const nextNodes = [...turn.nodes];
      const existingNode = nextNodes[nodeIndex];
      nextNodes[nodeIndex] = applyDeltaToAssistantTextNode(existingNode, entry);
      return { ...turn, nodes: nextNodes };
    });

    turns = nextTurns;
    if (foundExistingNode) {
      continue;
    }

    const message = messages.find((candidate) => candidate.id === messageId);
    if (message?.role !== 'assistant') {
      continue;
    }

    const targetTurnIndex = getTargetTurnIndex(projection, turns);
    if (targetTurnIndex < 0) {
      continue;
    }

    const targetTurn = turns[targetTurnIndex];
    const syntheticNode: TraceNode = {
      id: nodeId,
      type: 'assistant_text',
      content: entry.contentDelta,
      timestamp: message.timestamp,
      reasoning: entry.reasoningDelta || message.reasoning,
      thinking: message.thinking,
      artifacts: message.artifacts,
      metadata: message.metadata,
    };
    const nextTurn: TraceTurn = {
      ...targetTurn,
      nodes: [...targetTurn.nodes, syntheticNode],
    };
    turns = turns.map((turn, index) => index === targetTurnIndex ? nextTurn : turn);
    changed = true;
  }

  return changed ? { ...projection, turns } : projection;
  });
}

function getAssistantTextNodeId(messageId: string): string {
  return `${messageId}-text`;
}

function getTargetTurnIndex(projection: TraceProjection, turns: TraceTurn[]): number {
  if (projection.activeTurnIndex >= 0 && projection.activeTurnIndex < turns.length) {
    return projection.activeTurnIndex;
  }
  return turns.length - 1;
}

function applyDeltaToAssistantTextNode(
  node: TraceNode,
  entry: StreamingMessageDelta,
): TraceNode {
  return {
    ...node,
    content: node.content + entry.contentDelta,
    reasoning: (node.reasoning || '') + entry.reasoningDelta,
  };
}
