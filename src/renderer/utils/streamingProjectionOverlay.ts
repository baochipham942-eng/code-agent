import type { Message } from '@shared/contract';
import type { TraceNode, TraceProjection, TraceTurn } from '@shared/contract/trace';
import type { StreamingMessageDelta } from '../stores/streamingMessageAccumulatorStore';
import { remainingAssistantStreamDelta } from './assistantStreamDelta';
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

      // reasoning 增量回到它的原消息承载节点，不根据「此刻是否流式」搬到轮尾。
      // 这样同一事件序列在 accumulator overlay 与落账后的基投影里共用同一顺序；
      // 贴底视觉由 TurnCard 的稳定状态槽位承担。
      if (entry.reasoningDelta) {
        const target = nextNodes[nodeIndex];
        const remainingReasoning = remainingAssistantStreamDelta(
          target.reasoning || '',
          entry.reasoningDelta,
        );
        if (remainingReasoning) {
          nextNodes[nodeIndex] = {
            ...target,
            reasoning: (target.reasoning || '') + remainingReasoning,
          };
        }
      }

      // contentDelta 尾置（2026-07-21 追加，思路同上方 reasoningDelta）：多段
      // contentParts 消息（text 穿插 tool_call）里，首文本节点身后已落账的工具卡/
      // 后续正文段会把它挤出轮尾——这段新增量若仍打首节点，等于把答案期的新一段正文
      // 撑回轮首，产生与 reasoning 同款上方内容上跳。锚点取「本消息最后一个
      // assistant_text 节点」（即已落账的最新段），身后仍有节点时改落轮尾 live 节点。
      const contentLiveNodeId = getContentLiveNodeId(messageId);
      const contentLiveNodeIndex = nextNodes.findIndex((node) => node.id === contentLiveNodeId);
      const remainingContent = remainingAssistantStreamDelta(
        concatenatedAssistantText(nextNodes, messageId, nodeIndex),
        entry.contentDelta,
      );
      let contentTargetIndex = -1;
      if (remainingContent) {
        if (contentLiveNodeIndex >= 0) {
          contentTargetIndex = contentLiveNodeIndex;
        } else {
          const byMessageId = findLastAssistantTextIndexForMessage(nextNodes, messageId);
          // messageId 字段缺失（旧数据/测试夹具）时退回按 id 精确匹配的首节点，维持原行为。
          const lastMessageTextIndex = byMessageId >= 0 ? byMessageId : nodeIndex;
          if (lastMessageTextIndex >= 0 && lastMessageTextIndex === nextNodes.length - 1) {
            contentTargetIndex = lastMessageTextIndex;
          } else if (lastMessageTextIndex >= 0) {
            const anchor = nextNodes[lastMessageTextIndex];
            nextNodes.push({
              id: contentLiveNodeId,
              messageId: anchor.messageId,
              type: 'assistant_text',
              content: '',
              timestamp: anchor.timestamp,
            });
            contentTargetIndex = nextNodes.length - 1;
          }
        }
      }
      if (remainingContent && contentTargetIndex >= 0) {
        const target = nextNodes[contentTargetIndex];
        nextNodes[contentTargetIndex] = { ...target, content: target.content + remainingContent };
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

    const remainingContent = remainingAssistantStreamDelta(message.content || '', entry.contentDelta);
    const remainingReasoning = remainingAssistantStreamDelta(message.reasoning || '', entry.reasoningDelta);
    if (!remainingContent && !remainingReasoning) {
      continue;
    }
    const targetTurn = turns[targetTurnIndex];
    const syntheticNode: TraceNode = {
      id: nodeId,
      type: 'assistant_text',
      content: remainingContent ? entry.contentDelta : '',
      timestamp: message.timestamp,
      reasoning: remainingReasoning ? (entry.reasoningDelta || message.reasoning) : message.reasoning,
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
 * contentDelta 尾置 live 节点 id（同一消息多段 contentParts 里，新一段正文的流式
 * 增量落在这里，而不是打回已被工具卡挤出轮尾的首文本节点）。
 */
function getContentLiveNodeId(messageId: string): string {
  return `${messageId}-content-live`;
}

function findLastAssistantTextIndexForMessage(nodes: TraceNode[], messageId: string): number {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    if (nodes[i].type === 'assistant_text' && nodes[i].messageId === messageId) {
      return i;
    }
  }
  return -1;
}

function concatenatedAssistantText(nodes: TraceNode[], messageId: string, fallbackIndex: number): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'assistant_text') continue;
    if (
      node.messageId === messageId
      || node.id === `${messageId}-text`
      || node.id.startsWith(`${messageId}-text-`)
      || node.id === `${messageId}-content-live`
    ) {
      parts.push(node.content);
    }
  }
  if (parts.length > 0) return parts.join('');
  return nodes[fallbackIndex]?.content ?? '';
}

function getTargetTurnIndex(projection: TraceProjection, turns: TraceTurn[]): number {
  if (projection.activeTurnIndex >= 0 && projection.activeTurnIndex < turns.length) {
    return projection.activeTurnIndex;
  }
  return turns.length - 1;
}
