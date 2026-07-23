import {
  decideSurfaceIntent,
  type SurfaceArtifact,
  type SurfaceIntentDecision,
  type SurfaceIntentView,
} from '../utils/surfaceIntent';

interface SurfaceTurnState {
  autoFocusedView: SurfaceIntentDecision['view'] | null;
  userSwitchedAway: boolean;
}

interface SurfaceIntentContext {
  currentSessionId: string | null;
  turnId: string;
}

const turnStates = new Map<string, SurfaceTurnState>();
let activeContext: SurfaceIntentContext | null = null;

function contextKey(context: SurfaceIntentContext): string {
  return `${context.currentSessionId ?? '<none>'}\u0000${context.turnId}`;
}

function getTurnState(context: SurfaceIntentContext): SurfaceTurnState {
  const key = contextKey(context);
  const existing = turnStates.get(key);
  if (existing) return existing;
  const created: SurfaceTurnState = {
    autoFocusedView: null,
    userSwitchedAway: false,
  };
  turnStates.set(key, created);
  if (turnStates.size > 24) {
    const oldest = turnStates.keys().next().value as string | undefined;
    if (oldest) turnStates.delete(oldest);
  }
  return created;
}

export function syncSurfaceIntentContext(context: SurfaceIntentContext): void {
  activeContext = context;
  getTurnState(context);
}

export function noteSurfaceIntentNavigation(
  view: SurfaceIntentView,
  source: 'user' | 'auto',
): void {
  if (source !== 'user' || !activeContext) return;
  const state = getTurnState(activeContext);
  if (state.autoFocusedView && state.autoFocusedView !== view) {
    state.userSwitchedAway = true;
  }
}

export function requestSurfaceIntent(input: {
  artifact: SurfaceArtifact;
  artifactSessionId?: string;
  currentSessionId: string | null;
  turnId: string;
}): SurfaceIntentDecision | null {
  const context = {
    currentSessionId: input.currentSessionId,
    turnId: input.turnId,
  };
  syncSurfaceIntentContext(context);
  const state = getTurnState(context);
  const decision = decideSurfaceIntent({
    artifact: input.artifact,
    artifactSessionId: input.artifactSessionId,
    currentSessionId: input.currentSessionId,
    hasAutoFocusedThisTurn: state.autoFocusedView !== null,
    userSwitchedAwayThisTurn: state.userSwitchedAway,
  });
  if (decision) {
    state.autoFocusedView = decision.view;
  }
  return decision;
}

export function resetSurfaceIntentRuntimeForTests(): void {
  turnStates.clear();
  activeContext = null;
}
