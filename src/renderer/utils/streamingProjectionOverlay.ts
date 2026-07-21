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
      //   增长塞回轮首。contentDelta 同款尾置见下方。
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

      // contentDelta 尾置（2026-07-21 追加，思路同上方 reasoningDelta）：多段
      // contentParts 消息（text 穿插 tool_call）里，首文本节点身后已落账的工具卡/
      // 后续正文段会把它挤出轮尾——这段新增量若仍打首节点，等于把答案期的新一段正文
      // 撑回轮首，产生与 reasoning 同款上方内容上跳。锚点取「本消息最后一个
      // assistant_text 节点」（即已落账的最新段），身后仍有节点时改落轮尾 live 节点。
      const contentLiveNodeId = getContentLiveNodeId(messageId);
      const contentLiveNodeIndex = nextNodes.findIndex((node) => node.id === contentLiveNodeId);
      let contentTargetIndex = -1;
      if (entry.contentDelta) {
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
          // 基节点被 reasoning 尾置迁移吸收、本消息只剩 reasoning-live 节点的边缘场景：
          // 该节点 type 仍是 assistant_text 且带 messageId，上面的 byMessageId 查找已能
          // 命中它，不需要额外分支。
        }
      }
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

function getTargetTurnIndex(projection: TraceProjection, turns: TraceTurn[]): number {
  if (projection.activeTurnIndex >= 0 && projection.activeTurnIndex < turns.length) {
    return projection.activeTurnIndex;
  }
  return turns.length - 1;
}

