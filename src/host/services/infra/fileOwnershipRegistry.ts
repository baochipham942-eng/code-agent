import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { minimatch } from 'minimatch';
import {
  getSwarmRunScopeKey,
  type SwarmRunScope,
} from '../../../shared/contract/swarm';
import type { ManagedAgent } from '../../agent/spawnGuard';
import { getFileMutationActorId } from '../../tools/modules/file/fileMutationIdentity';
import { resolveCanonicalRunPath } from '../../runtime/runContext';

export interface FileOwnershipActor {
  actorId: string;
  agentId: string;
  sessionId: string;
  scope?: SwarmRunScope;
  workingDirectory: string;
}

export interface FileOwnershipConflict {
  requesterActor: string;
  requesterAgentId: string;
  path: string;
  ownerActor: string;
  ownerAgentId: string;
  kind: 'declared' | 'claimed';
}

export type FileOwnershipClaimResult =
  | { ok: true }
  | { ok: false; conflict: FileOwnershipConflict };

export interface FileOwnershipSnapshot {
  scope: string;
  actors: Array<{
    actorId: string;
    agentId: string;
    declared: string[];
    claimed: string[];
    uncertain: string[];
  }>;
  conflicts: FileOwnershipConflict[];
  uncertainCount: number;
}

interface ActorState {
  actor: FileOwnershipActor;
  declared: Set<string>;
  claimed: Set<string>;
  uncertain: Set<string>;
}

interface ScopeState {
  actors: Map<string, ActorState>;
  conflicts: Map<string, FileOwnershipConflict>;
}

interface CompletionHook {
  onComplete(callback: (agent: ManagedAgent) => void): void;
}

const boundCompletionHooks = new WeakSet<object>();

function scopeKey(actor: Pick<FileOwnershipActor, 'scope' | 'sessionId'>): string {
  return actor.scope ? getSwarmRunScopeKey(actor.scope) : `session:${actor.sessionId}`;
}

function expandHome(rawPath: string): string {
  if (rawPath === '~') return os.homedir();
  return rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
}

function normalizeDeclaredPath(rawPath: string, workingDirectory: string): string {
  const expanded = expandHome(rawPath.trim());
  return resolveCanonicalRunPath(
    path.isAbsolute(expanded) ? expanded : path.resolve(workingDirectory, expanded),
  );
}

function declaredMatches(declared: string, target: string): boolean {
  if (minimatch(target, declared, { dot: true })) return true;
  const relative = path.relative(declared, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

class FileOwnershipRegistry extends EventEmitter {
  private readonly scopes = new Map<string, ScopeState>();

  declare(actor: FileOwnershipActor, paths: readonly string[]): void {
    if (paths.length === 0) return;
    const state = this.actorState(actor);
    for (const ownedPath of paths) {
      if (typeof ownedPath !== 'string' || ownedPath.trim() === '') continue;
      state.declared.add(normalizeDeclaredPath(ownedPath, actor.workingDirectory));
    }
  }

  checkAndClaim(actor: FileOwnershipActor, absolutePath: string): FileOwnershipClaimResult {
    const target = resolveCanonicalRunPath(absolutePath);
    const state = this.scopeState(actor);
    this.actorState(actor);
    for (const other of state.actors.values()) {
      if (other.actor.actorId === actor.actorId) continue;
      if (sorted(other.declared).some((declared) => declaredMatches(declared, target))) {
        return this.conflict(state, actor, other.actor, target, 'declared');
      }
    }
    for (const other of state.actors.values()) {
      if (other.actor.actorId === actor.actorId) continue;
      if (other.claimed.has(target)) {
        return this.conflict(state, actor, other.actor, target, 'claimed');
      }
    }
    this.actorState(actor).claimed.add(target);
    return { ok: true };
  }

  recordUncertain(actor: FileOwnershipActor, uncertain: readonly string[]): void {
    if (uncertain.length === 0) return;
    const state = this.actorState(actor);
    for (const item of uncertain) state.uncertain.add(item);
  }

  release(actor: Pick<FileOwnershipActor, 'actorId' | 'scope' | 'sessionId'>): void {
    const key = scopeKey(actor);
    const state = this.scopes.get(key);
    if (!state) return;
    state.actors.delete(actor.actorId);
    if (state.actors.size === 0) this.scopes.delete(key);
  }

  releaseAgent(agentId: string, scope?: SwarmRunScope): void {
    for (const [key, state] of this.scopes) {
      if (scope && key !== getSwarmRunScopeKey(scope)) continue;
      for (const [actorId, actor] of state.actors) {
        if (actor.actor.agentId === agentId) state.actors.delete(actorId);
      }
      if (state.actors.size === 0) this.scopes.delete(key);
    }
  }

  listConflicts(scope: SwarmRunScope | string): FileOwnershipConflict[] {
    const key = typeof scope === 'string' ? `session:${scope}` : getSwarmRunScopeKey(scope);
    return [...(this.scopes.get(key)?.conflicts.values() ?? [])]
      .sort((left, right) => this.conflictKey(left).localeCompare(this.conflictKey(right)));
  }

  snapshot(scope: SwarmRunScope | string): FileOwnershipSnapshot {
    const key = typeof scope === 'string' ? `session:${scope}` : getSwarmRunScopeKey(scope);
    const state = this.scopes.get(key);
    const actors = [...(state?.actors.values() ?? [])]
      .map((entry) => ({
        actorId: entry.actor.actorId,
        agentId: entry.actor.agentId,
        declared: sorted(entry.declared),
        claimed: sorted(entry.claimed),
        uncertain: sorted(entry.uncertain),
      }))
      .sort((left, right) => left.actorId.localeCompare(right.actorId));
    return {
      scope: key,
      actors,
      conflicts: this.listConflicts(scope),
      uncertainCount: actors.reduce((count, actor) => count + actor.uncertain.length, 0),
    };
  }

  private scopeState(actor: FileOwnershipActor): ScopeState {
    const key = scopeKey(actor);
    let state = this.scopes.get(key);
    if (!state) {
      state = { actors: new Map(), conflicts: new Map() };
      this.scopes.set(key, state);
    }
    return state;
  }

  private actorState(actor: FileOwnershipActor): ActorState {
    const scope = this.scopeState(actor);
    let state = scope.actors.get(actor.actorId);
    if (!state) {
      state = { actor, declared: new Set(), claimed: new Set(), uncertain: new Set() };
      scope.actors.set(actor.actorId, state);
    }
    return state;
  }

  private conflict(
    state: ScopeState,
    requester: FileOwnershipActor,
    owner: FileOwnershipActor,
    target: string,
    kind: FileOwnershipConflict['kind'],
  ): FileOwnershipClaimResult {
    const conflict: FileOwnershipConflict = {
      requesterActor: requester.actorId,
      requesterAgentId: requester.agentId,
      path: target,
      ownerActor: owner.actorId,
      ownerAgentId: owner.agentId,
      kind,
    };
    const key = this.conflictKey(conflict);
    if (!state.conflicts.has(key)) {
      state.conflicts.set(key, conflict);
      this.emit('ownership:conflict', conflict);
    }
    return { ok: false, conflict: state.conflicts.get(key)! };
  }

  private conflictKey(conflict: FileOwnershipConflict): string {
    return `${conflict.requesterActor}\0${conflict.path}\0${conflict.ownerActor}`;
  }
}

const fileOwnershipRegistry = new FileOwnershipRegistry();

export function createFileOwnershipActor(input: {
  sessionId: string;
  agentId?: string;
  swarmRunScope?: SwarmRunScope;
  workingDirectory: string;
}): FileOwnershipActor | undefined {
  const actorId = getFileMutationActorId(input);
  const agentId = input.agentId?.trim();
  if (!actorId || !agentId) return undefined;
  return {
    actorId,
    agentId,
    sessionId: input.sessionId,
    scope: input.swarmRunScope,
    workingDirectory: input.workingDirectory,
  };
}

export async function withFileOwnership<T>(
  input: Parameters<typeof createFileOwnershipActor>[0] & { ownedPaths?: string[] },
  run: () => Promise<T>,
): Promise<T> {
  const actor = createFileOwnershipActor(input);
  if (actor) fileOwnershipRegistry.declare(actor, input.ownedPaths ?? []);
  try {
    return await run();
  } finally {
    if (actor) fileOwnershipRegistry.release(actor);
  }
}

export function bindFileOwnershipReleaseHook(guard: CompletionHook): void {
  if (boundCompletionHooks.has(guard)) return;
  boundCompletionHooks.add(guard);
  guard.onComplete((agent) => fileOwnershipRegistry.releaseAgent(agent.id, agent.scope));
}

export function getFileOwnershipRegistry(): FileOwnershipRegistry {
  return fileOwnershipRegistry;
}
