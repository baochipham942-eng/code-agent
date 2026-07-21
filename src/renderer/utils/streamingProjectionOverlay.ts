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
    const liveNodeId = getReasoningLiveNodeId(messageId);
    let foundExistingNode = false;

    const nextTurns = turns.map((turn) => {
      const nodeIndex = turn.nodes.findIndex((node) =>
        node.type === 'assistant_text' && node.id === nodeId
      );
      const liveNodeIndex = turn.nodes.findIndex((node) => node.id === liveNodeId);
      if (nodeIndex < 0 && liveNodeIndex < 0) {
        return turn;
      }

      foundExistingNode = true;
      changed = true;
      const nextNodes = [...turn.nodes];

      // reasoningDelta 的落点决定增长发生在视口哪里（2026-07-21 真机闪烁根因）：
      // - 已有 live 尾节点 → 原地追加（在轮尾，增长贴底边）；
      // - 首文本节点就是轮尾 → 保持原地追加（轮初期，行为不变）;
      // - 首文本节点身后已有其它节点（工具卡等）→ 在轮尾新建 live 节点，禁止把
      //   增长塞回轮首。contentDelta 维持原行为（正文流式属答案期，见下方 ponytail）。
      let reasoningTargetIndex = -1;
      if (entry.reasoningDelta) {
        if (liveNodeIndex >= 0) {
          reasoningTargetIndex = liveNodeIndex;
        } else if (nodeIndex >= 0 && nodeIndex === nextNodes.length - 1) {
          reasoningTargetIndex = nodeIndex;
        } else if (nodeIndex >= 0) {
          const anchor = nextNodes[nodeIndex];
          nextNodes.push({
            id: liveNodeId,
            messageId: anchor.messageId,
            type: 'assistant_text',
            content: '',
            timestamp: anchor.timestamp,
          });
          reasoningTargetIndex = nextNodes.length - 1;
        }
      }
      if (reasoningTargetIndex >= 0) {
        const target = nextNodes[reasoningTargetIndex];
        nextNodes[reasoningTargetIndex] = {
          ...target,
          reasoning: (target.reasoning || '') + entry.reasoningDelta,
        };
      }

      // ponytail: contentDelta 仍打首文本节点（多段 contentParts 消息里它可能不在轮尾，
      // 答案期流式正文的同类位移问题留给下一批——本批只治思考流）。基节点不存在而
      // live 节点存在的边缘（基节点被尾置迁移吸收）时正文落 live 节点，不丢字。
      const contentTargetIndex = nodeIndex >= 0
        ? nodeIndex
        : nextNodes.findIndex((node) => node.id === liveNodeId);
      if (entry.contentDelta && contentTargetIndex >= 0) {
        const target = nextNodes[contentTargetIndex];
        nextNodes[contentTargetIndex] = { ...target, content: target.content + entry.contentDelta };
      }
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

/**
 * 活动轮「思考尾置」live 节点 id（useTurnProjection 迁移已落账 reasoning、本 overlay
 * 追加未落账 reasoningDelta 共用同一节点，保证流式思考连成一块且始终在轮尾增长）。
 */
export function getReasoningLiveNodeId(messageId: string): string {
  return `${messageId}-reasoning-live`;
}

function getTargetTurnIndex(projection: TraceProjection, turns: TraceTurn[]): number {
  if (projection.activeTurnIndex >= 0 && projection.activeTurnIndex < turns.length) {
    return projection.activeTurnIndex;
  }
  return turns.length - 1;
}

