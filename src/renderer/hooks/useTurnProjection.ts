// ============================================================================
// useTurnProjection - Project messages[] into TraceTurns
// Pure derivation via useMemo, no new state or store
// ============================================================================

import { useMemo } from 'react';
import type { Message } from '@shared/contract';
import type { TraceProjection, TraceTurn, TraceNode } from '@shared/contract/trace';
import { isSkillStatusContent } from '../components/features/chat/MessageBubble/SkillStatusMessage';

export function useTurnProjection(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean
): TraceProjection {
  return useMemo(() => {
    if (!sessionId) {
      return { sessionId: '', turns: [], activeTurnIndex: -1 };
    }

    const turns: TraceTurn[] = [];
    let currentTurn: TraceTurn | null = null;
    let turnCounter = 0;

    for (const msg of messages) {
      // Skip isMeta messages (Skill system internal)
      if (msg.isMeta) continue;
      // Skip tool role messages (results shown in toolCalls)
      if (msg.role === 'tool') continue;

      // Compaction → system node, attach to current turn or create standalone
      if (msg.compaction) {
        const node: TraceNode = {
          id: `${msg.id}-compaction`,
          type: 'system',
          content: msg.compaction.content,
          timestamp: msg.timestamp,
          subtype: 'compaction',
        };
        if (currentTurn) {
          currentTurn.nodes.push(node);
        } else {
          turnCounter++;
          turns.push({
            turnNumber: turnCounter,
            turnId: `turn-${turnCounter}`,
            nodes: [node],
            status: 'completed',
            startTime: msg.timestamp,
            endTime: msg.timestamp,
          });
        }
        continue;
      }

      // System messages → skip (nudges, recovery hints)
      if (msg.role === 'system') continue;

      // User message → start a new turn
      if (msg.role === 'user') {
        // Close previous turn
        if (currentTurn) {
          currentTurn.status = 'completed';
          if (currentTurn.nodes.length > 0) {
            currentTurn.endTime = currentTurn.nodes[currentTurn.nodes.length - 1].timestamp;
          }
        }

        turnCounter++;
        currentTurn = {
          turnNumber: turnCounter,
          turnId: `turn-${turnCounter}`,
          nodes: [],
          status: 'completed',
          startTime: msg.timestamp,
        };
        turns.push(currentTurn);

        // Skill status message
        if (msg.source === 'skill' && isSkillStatusContent(msg.content)) {
          currentTurn.nodes.push({
            id: msg.id,
            type: 'system',
            content: msg.content,
            timestamp: msg.timestamp,
            subtype: 'skill_status',
          });
        } else {
          currentTurn.nodes.push({
            id: msg.id,
            type: 'user',
            content: msg.content,
            timestamp: msg.timestamp,
            attachments: msg.attachments,
          });
        }
        continue;
      }

      // Assistant message → add nodes to current turn
      if (msg.role === 'assistant') {
        // If no current turn (e.g. assistant message without preceding user), create one
        if (!currentTurn) {
          turnCounter++;
          currentTurn = {
            turnNumber: turnCounter,
            turnId: `turn-${turnCounter}`,
            nodes: [],
            status: 'completed',
            startTime: msg.timestamp,
          };
          turns.push(currentTurn);
        }

        const hasContent = msg.content && msg.content.trim().length > 0;
        const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

        // Skip empty assistant messages
        if (!hasContent && !hasToolCalls) continue;

        // Text content node
        if (hasContent) {
          currentTurn.nodes.push({
            id: `${msg.id}-text`,
            type: 'assistant_text',
            content: msg.content,
            timestamp: msg.timestamp,
            reasoning: msg.reasoning,
            thinking: msg.thinking,
          });
        }

        // Tool call nodes
        if (hasToolCalls) {
          for (const tc of msg.toolCalls!) {
            currentTurn.nodes.push({
              id: `${msg.id}-tc-${tc.id}`,
              type: 'tool_call',
              content: '',
              timestamp: msg.timestamp,
              toolCall: {
                id: tc.id,
                name: tc.name,
                args: tc.arguments,
                result: tc.result?.output || tc.result?.error,
                success: tc.result?.success,
                duration: tc.result?.duration,
                _streaming: tc._streaming,
              },
            });
          }
        }
      }
    }

    // Mark the last turn as streaming if processing
    let activeTurnIndex = -1;
    if (isProcessing && turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      lastTurn.status = 'streaming';
      activeTurnIndex = turns.length - 1;
    } else if (currentTurn) {
      currentTurn.status = 'completed';
      if (currentTurn.nodes.length > 0) {
        currentTurn.endTime = currentTurn.nodes[currentTurn.nodes.length - 1].timestamp;
      }
    }

    return {
      sessionId,
      turns,
      activeTurnIndex,
    };
  }, [messages, sessionId, isProcessing]);
}
