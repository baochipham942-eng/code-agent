import { useMemo } from 'react';
import type { TraceProjection } from '@shared/contract/trace';
import type {
  TurnArtifactOwnershipItem,
  TurnTimelineTone,
} from '@shared/contract/turnTimeline';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';

export interface CurrentTurnArtifactOwnershipView {
  turnId: string;
  turnNumber: number;
  tone: TurnTimelineTone;
  artifactOwnership: TurnArtifactOwnershipItem[];
}

export function extractCurrentTurnArtifactOwnership(
  projection: TraceProjection,
): CurrentTurnArtifactOwnershipView | null {
  const currentTurn = projection.turns[projection.turns.length - 1];
  if (!currentTurn) {
    return null;
  }

  const timeline = currentTurn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'artifact_ownership'
    && node.turnTimeline.artifactOwnership?.length,
  )?.turnTimeline;

  if (!timeline?.artifactOwnership?.length) {
    return null;
  }

  return {
    turnId: currentTurn.turnId,
    turnNumber: currentTurn.turnNumber,
    tone: timeline.tone,
    artifactOwnership: timeline.artifactOwnership,
  };
}

export function useCurrentTurnArtifactOwnership(): CurrentTurnArtifactOwnershipView | null {
  const projection = useCurrentTurnExecutionProjection();

  return useMemo(
    () => extractCurrentTurnArtifactOwnership(projection),
    [projection],
  );
}
