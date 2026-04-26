// ============================================================================
// useTurnProjection - Project messages[] into TraceTurns
// Pure derivation via useMemo, no new state or store
// ============================================================================

import { useMemo } from 'react';
import type { Message } from '@shared/contract';
import type { TraceProjection, TraceTurn, TraceNode } from '@shared/contract/trace';
import type { SwarmLaunchRequest } from '@shared/contract/swarm';
import { isSkillStatusContent } from '../components/features/chat/MessageBubble/SkillStatusMessage';

export function projectTurns(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean,
  launchRequests: SwarmLaunchRequest[] = [],
): TraceProjection {
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
          metadata: msg.metadata,
        });
      } else {
        currentTurn.nodes.push({
          id: msg.id,
          type: 'user',
          content: msg.content,
          timestamp: msg.timestamp,
          attachments: msg.attachments,
          metadata: msg.metadata,
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
          artifacts: msg.artifacts,
          metadata: msg.metadata,
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
              outputPath: tc.result?.outputPath,
              metadata: tc.result?.metadata,
              _streaming: tc._streaming,
              shortDescription: tc.shortDescription,
              targetContext: tc.targetContext,
              expectedOutcome: tc.expectedOutcome,
            },
            metadata: msg.metadata,
          });
        }
      }
    }
  }

  const pendingLaunchRequest = [...launchRequests]
    .reverse()
    .find((request) => request.status === 'pending' && request.sessionId === sessionId);
  if (pendingLaunchRequest) {
    const launchNode: TraceNode = {
      id: `swarm-launch-${pendingLaunchRequest.id}`,
      type: 'swarm_launch_request',
      content: pendingLaunchRequest.summary,
      timestamp: pendingLaunchRequest.requestedAt,
      launchRequest: pendingLaunchRequest,
    };

    if (currentTurn) {
      currentTurn.nodes.push(launchNode);
      currentTurn.endTime = pendingLaunchRequest.requestedAt;
    } else {
      turnCounter++;
      currentTurn = {
        turnNumber: turnCounter,
        turnId: `turn-${turnCounter}`,
        nodes: [launchNode],
        status: 'completed',
        startTime: pendingLaunchRequest.requestedAt,
        endTime: pendingLaunchRequest.requestedAt,
      };
      turns.push(currentTurn);
    }
  }

  // Mark the most recent assistant/tool turn as streaming if processing.
  // This avoids a direct-routed user turn stealing the active marker.
  let activeTurnIndex = -1;
  if (isProcessing && turns.length > 0) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const candidateTurn = turns[index];
      const lastNode = candidateTurn.nodes[candidateTurn.nodes.length - 1];
      if (!lastNode) continue;

      if (lastNode.type === 'assistant_text' || lastNode.type === 'tool_call') {
        candidateTurn.status = 'streaming';
        activeTurnIndex = index;
        break;
      }
    }
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
}

export function useTurnProjection(
  messages: Message[],
  sessionId: string | null,
  isProcessing: boolean,
  launchRequests: SwarmLaunchRequest[] = [],
): TraceProjection {
  return useMemo(
    () => projectTurns(messages, sessionId, isProcessing, launchRequests),
    [messages, sessionId, isProcessing, launchRequests],
  );
}
