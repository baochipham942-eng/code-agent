import {
  getSwarmRunScopeKey,
  isSameSwarmRun,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';

interface SingleSpawnVisibilityEntry {
  scope: SwarmRunScope;
  agentIds: Set<string>;
}

const entries = new Map<string, SingleSpawnVisibilityEntry>();

function runKey(ref: SwarmRunRef): string {
  return `${ref.sessionId}\u0000${ref.runId}`;
}

export function registerSingleSpawnVisibility(
  scope: SwarmRunScope,
  agentId: string,
): () => void {
  const key = runKey(scope);
  const existing = entries.get(key);
  if (existing && getSwarmRunScopeKey(existing.scope) !== getSwarmRunScopeKey(scope)) {
    throw new Error('Single-spawn visibility run identity collision.');
  }
  const entry = existing ?? { scope: { ...scope }, agentIds: new Set<string>() };
  entry.agentIds.add(agentId);
  entries.set(key, entry);

  return () => {
    const current = entries.get(key);
    if (!current) return;
    current.agentIds.delete(agentId);
    if (current.agentIds.size === 0) entries.delete(key);
  };
}

export function resolveSingleSpawnVisibility(
  ref: SwarmRunRef,
): { scope: SwarmRunScope; agentIds: string[] } | undefined {
  const entry = entries.get(runKey(ref));
  if (!entry || !isSameSwarmRun(entry.scope, ref)) return undefined;
  return { scope: { ...entry.scope }, agentIds: [...entry.agentIds] };
}

export function hasSingleSpawnVisibilityAgent(
  ref: SwarmRunRef,
  agentId: string,
): boolean {
  return resolveSingleSpawnVisibility(ref)?.agentIds.includes(agentId) ?? false;
}

export function resetSingleSpawnVisibilityRegistry(): void {
  entries.clear();
}
