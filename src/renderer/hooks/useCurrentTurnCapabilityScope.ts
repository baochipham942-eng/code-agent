import { useMemo } from 'react';
import type { TraceProjection } from '@shared/contract/trace';
import type {
  TurnCapabilityScope,
  TurnTimelineTone,
  TurnWorkbenchSnapshot,
} from '@shared/contract/turnTimeline';
import { useWorkbenchCapabilities, type WorkbenchCapabilities } from './useWorkbenchCapabilities';
import { useCurrentTurnExecutionProjection } from './useCurrentTurnExecutionProjection';
import {
  buildSelectedWorkbenchCapabilityRegistryItems,
  type WorkbenchCapabilityRegistryItem,
} from '../utils/workbenchCapabilityRegistry';

export interface CurrentTurnCapabilityScopeView {
  turnId: string;
  turnNumber: number;
  tone: TurnTimelineTone;
  scope: TurnCapabilityScope;
}

export interface CurrentTurnCapabilityScopeState extends CurrentTurnCapabilityScopeView {
  selectedCapabilities: WorkbenchCapabilityRegistryItem[];
  blockedCapabilities: WorkbenchCapabilityRegistryItem[];
}

export function extractCurrentTurnCapabilityScope(
  projection: TraceProjection,
): CurrentTurnCapabilityScopeView | null {
  const currentTurn = projection.turns[projection.turns.length - 1];
  if (!currentTurn) {
    return null;
  }

  const timeline = currentTurn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'capability_scope'
    && node.turnTimeline.capabilityScope,
  )?.turnTimeline;

  if (!timeline?.capabilityScope) {
    return null;
  }

  return {
    turnId: currentTurn.turnId,
    turnNumber: currentTurn.turnNumber,
    tone: timeline.tone,
    scope: timeline.capabilityScope,
  };
}

export function extractCurrentTurnWorkbenchSnapshot(
  projection: TraceProjection,
): TurnWorkbenchSnapshot | null {
  const currentTurn = projection.turns[projection.turns.length - 1];
  if (!currentTurn) {
    return null;
  }

  const timeline = currentTurn.nodes.find((node) =>
    node.type === 'turn_timeline'
    && node.turnTimeline?.kind === 'workbench_snapshot'
    && node.turnTimeline.snapshot,
  )?.turnTimeline;

  return timeline?.snapshot || null;
}

export function buildCurrentTurnBlockedCapabilities(args: {
  projection: TraceProjection;
  capabilities: WorkbenchCapabilities;
}): WorkbenchCapabilityRegistryItem[] {
  return buildCurrentTurnSelectedCapabilities(args)
    .filter((capability) => capability.blocked);
}

export function buildCurrentTurnSelectedCapabilities(args: {
  projection: TraceProjection;
  capabilities: WorkbenchCapabilities;
}): WorkbenchCapabilityRegistryItem[] {
  const snapshot = extractCurrentTurnWorkbenchSnapshot(args.projection);
  if (!snapshot) {
    return [];
  }

  return buildSelectedWorkbenchCapabilityRegistryItems(snapshot, args.capabilities);
}

export function useCurrentTurnCapabilityScope(): CurrentTurnCapabilityScopeState | null {
  const capabilities = useWorkbenchCapabilities();
  const projection = useCurrentTurnExecutionProjection();

  return useMemo(
    () => {
      const scopeView = extractCurrentTurnCapabilityScope(projection);
      if (!scopeView) {
        return null;
      }

      return {
        ...scopeView,
        selectedCapabilities: buildCurrentTurnSelectedCapabilities({
          projection,
          capabilities,
        }),
        blockedCapabilities: buildCurrentTurnBlockedCapabilities({
          projection,
          capabilities,
        }),
      };
    },
    [capabilities, projection],
  );
}
