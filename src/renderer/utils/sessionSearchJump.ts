import type { TraceProjection } from '@shared/contract/trace';
import type { CrossSessionSearchResultItem } from '@shared/ipc/types';
import type { SearchMatch } from '../components/features/chat/ChatSearchBar';
import type { PendingSessionSearchJump } from '../stores/sessionUIStore';

export function createPendingSearchJumpFromCrossSessionResult(
  result: CrossSessionSearchResultItem,
  query: string,
  createdAt = Date.now(),
): PendingSessionSearchJump {
  return {
    sessionId: result.sessionId,
    messageId: result.messageId,
    messageIndex: result.messageIndex,
    turnNumber: result.turnNumber,
    matchOffset: result.matchOffset,
    query: query.trim(),
    createdAt,
  };
}

function findQueryInTurn(
  projection: TraceProjection,
  turnIndex: number,
  query: string,
): SearchMatch | null {
  const turn = projection.turns[turnIndex];
  if (!turn || !query) return null;

  for (let nodeIndex = 0; nodeIndex < turn.nodes.length; nodeIndex += 1) {
    const node = turn.nodes[nodeIndex];
    const offset = node.content.toLowerCase().indexOf(query);
    if (offset >= 0) {
      return { turnIndex, nodeIndex, offset };
    }
  }

  return null;
}

export function findSearchMatchForPendingJump(
  projection: TraceProjection,
  jump: PendingSessionSearchJump,
): SearchMatch | null {
  if (projection.sessionId !== jump.sessionId) {
    return null;
  }

  const query = jump.query.trim().toLowerCase();
  let fallback: SearchMatch | null = null;
  const targetTurnIndex = typeof jump.turnNumber === 'number'
    ? projection.turns.findIndex((turn) => turn.turnNumber === jump.turnNumber)
    : -1;

  if (jump.messageId) {
    for (let turnIndex = 0; turnIndex < projection.turns.length; turnIndex += 1) {
      const turn = projection.turns[turnIndex];
      for (let nodeIndex = 0; nodeIndex < turn.nodes.length; nodeIndex += 1) {
        const node = turn.nodes[nodeIndex];
        if (node.messageId !== jump.messageId && node.id !== jump.messageId) {
          continue;
        }

        const content = node.content.toLowerCase();
        const queryOffset = query ? content.indexOf(query) : -1;
        if (query && queryOffset === -1) {
          fallback ??= { turnIndex, nodeIndex, offset: 0 };
          continue;
        }

        const preferredOffset = typeof jump.matchOffset === 'number' ? jump.matchOffset : -1;
        const offset = queryOffset >= 0
          ? queryOffset
          : preferredOffset >= 0 && preferredOffset < node.content.length
            ? preferredOffset
            : 0;

        return {
          turnIndex,
          nodeIndex,
          offset: Math.max(0, offset),
        };
      }
    }

    if (fallback) {
      return fallback;
    }
  }

  if (targetTurnIndex >= 0) {
    const turnMatch = findQueryInTurn(projection, targetTurnIndex, query);
    if (turnMatch) {
      return turnMatch;
    }
  }

  for (let turnIndex = 0; turnIndex < projection.turns.length; turnIndex += 1) {
    const turnMatch = findQueryInTurn(projection, turnIndex, query);
    if (turnMatch) {
      return turnMatch;
    }
  }

  return null;
}
