import { useMemo } from 'react';
import type { TraceProjection, TraceTurn } from '@shared/contract/trace';
import type {
  TurnArtifactOwnershipItem,
  TurnRoutingEvidence,
  TurnTimelineTone,
} from '@shared/contract/turnTimeline';
import {
  buildArtifactOwnershipItems,
  isReadOnlyArtifactOwnershipItem,
} from '../utils/artifactOwnership';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';

export interface CurrentTurnArtifactOwnershipView {
  turnId: string;
  turnNumber: number;
  tone: TurnTimelineTone;
  artifactOwnership: TurnArtifactOwnershipItem[];
}

function artifactOwnershipKey(item: TurnArtifactOwnershipItem): string {
  if (item.path) return `path:${item.path}`;
  if (item.url) return `url:${item.url}`;
  return `${item.kind}:${item.ownerKind}:${item.ownerLabel}:${item.label}`;
}

function findTurnRoutingEvidence(turn: TraceTurn): TurnRoutingEvidence | undefined {
  return turn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'routing_evidence'
    && node.turnTimeline.routingEvidence,
  )?.turnTimeline?.routingEvidence;
}

export function extractCurrentTurnArtifactOwnership(
  projection: TraceProjection,
): CurrentTurnArtifactOwnershipView | null {
  const currentTurn = projection.turns[projection.turns.length - 1];
  if (!currentTurn) {
    return null;
  }

  const routingEvidence = findTurnRoutingEvidence(currentTurn);
  const projectedArtifacts = buildArtifactOwnershipItems(currentTurn, routingEvidence);
  const timeline = currentTurn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'artifact_ownership'
    && node.turnTimeline.artifactOwnership?.length,
  )?.turnTimeline;

  const artifactOwnership = (timeline?.artifactOwnership ?? [])
    .filter((item) => !isReadOnlyArtifactOwnershipItem(item));
  const seen = new Set(artifactOwnership.map(artifactOwnershipKey));
  for (const item of projectedArtifacts) {
    const key = artifactOwnershipKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    artifactOwnership.push(item);
  }

  if (!artifactOwnership.length) {
    return null;
  }

  return {
    turnId: currentTurn.turnId,
    turnNumber: currentTurn.turnNumber,
    tone: timeline?.tone ?? 'success',
    artifactOwnership,
  };
}

export function useCurrentTurnArtifactOwnership(): CurrentTurnArtifactOwnershipView | null {
  const projection = useCurrentTurnExecutionProjection();

  return useMemo(
    () => extractCurrentTurnArtifactOwnership(projection),
    [projection],
  );
}
