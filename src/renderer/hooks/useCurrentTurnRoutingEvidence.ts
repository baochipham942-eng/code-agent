import { useMemo } from 'react';
import type { TraceProjection } from '@shared/contract/trace';
import type {
  TurnRoutingEvidence,
  TurnTimelineTone,
} from '@shared/contract/turnTimeline';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';

export interface CurrentTurnRoutingEvidenceView {
  turnId: string;
  turnNumber: number;
  tone: TurnTimelineTone;
  routingEvidence: TurnRoutingEvidence;
}

export function extractCurrentTurnRoutingEvidence(
  projection: TraceProjection,
): CurrentTurnRoutingEvidenceView | null {
  const currentTurn = projection.turns[projection.turns.length - 1];
  if (!currentTurn) {
    return null;
  }

  const timeline = currentTurn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'routing_evidence'
    && node.turnTimeline.routingEvidence,
  )?.turnTimeline;

  if (!timeline?.routingEvidence) {
    return null;
  }

  return {
    turnId: currentTurn.turnId,
    turnNumber: currentTurn.turnNumber,
    tone: timeline.tone,
    routingEvidence: timeline.routingEvidence,
  };
}

export function useCurrentTurnRoutingEvidence(): CurrentTurnRoutingEvidenceView | null {
  const projection = useCurrentTurnExecutionProjection();

  return useMemo(
    () => extractCurrentTurnRoutingEvidence(projection),
    [projection],
  );
}
