// ============================================================================
// Context Intervention State - Tracks pin/exclude/retain selections per session/agent
// ============================================================================

import type { ContextInterventionSnapshot } from '../../shared/types/contextView';

type InterventionKey = string;

interface InterventionRecord {
  pinned: Set<string>;
  excluded: Set<string>;
  retained: Set<string>;
}

export class ContextInterventionState {
  private readonly store = new Map<InterventionKey, InterventionRecord>();

  private buildKey(sessionId?: string, agentId?: string): InterventionKey {
    const resolvedSession = sessionId?.trim() || 'global';
    const resolvedAgent = agentId?.trim() || 'global';
    return `${resolvedSession}:${resolvedAgent}`;
  }

  private ensureRecord(key: InterventionKey): InterventionRecord {
    let record = this.store.get(key);
    if (!record) {
      record = {
        pinned: new Set(),
        excluded: new Set(),
        retained: new Set(),
      };
      this.store.set(key, record);
    }
    return record;
  }

  getSnapshot(sessionId?: string, agentId?: string): ContextInterventionSnapshot {
    const record = this.ensureRecord(this.buildKey(sessionId, agentId));
    return {
      pinned: Array.from(record.pinned),
      excluded: Array.from(record.excluded),
      retained: Array.from(record.retained),
    };
  }

  getEffectiveSnapshot(sessionId?: string, agentId?: string): ContextInterventionSnapshot {
    const globalSnapshot = this.getSnapshot(sessionId, undefined);
    if (!agentId?.trim()) {
      return globalSnapshot;
    }
    const scopedSnapshot = this.getSnapshot(sessionId, agentId);
    return mergeInterventionSnapshots(globalSnapshot, scopedSnapshot);
  }

  applyIntervention(
    sessionId: string | undefined,
    agentId: string | undefined,
    messageId: string,
    action: 'pin' | 'exclude' | 'retain',
    enabled: boolean,
  ): ContextInterventionSnapshot {
    const record = this.ensureRecord(this.buildKey(sessionId, agentId));
    record.pinned.delete(messageId);
    record.excluded.delete(messageId);
    record.retained.delete(messageId);
    const target = this.resolveSet(record, action);

    if (enabled) {
      target.add(messageId);
    }

    return this.getSnapshot(sessionId, agentId);
  }

  private resolveSet(record: InterventionRecord, action: 'pin' | 'exclude' | 'retain'): Set<string> {
    switch (action) {
      case 'pin':
        return record.pinned;
      case 'exclude':
        return record.excluded;
      case 'retain':
        return record.retained;
    }
  }
}

function applySnapshotStatus(
  statusById: Map<string, 'pin' | 'exclude' | 'retain'>,
  snapshot: ContextInterventionSnapshot,
): void {
  for (const id of snapshot.pinned) statusById.set(id, 'pin');
  for (const id of snapshot.excluded) statusById.set(id, 'exclude');
  for (const id of snapshot.retained) statusById.set(id, 'retain');
}

export function mergeInterventionSnapshots(
  base: ContextInterventionSnapshot,
  override: ContextInterventionSnapshot,
): ContextInterventionSnapshot {
  const statusById = new Map<string, 'pin' | 'exclude' | 'retain'>();
  applySnapshotStatus(statusById, base);
  applySnapshotStatus(statusById, override);

  const merged: ContextInterventionSnapshot = {
    pinned: [],
    excluded: [],
    retained: [],
  };

  for (const [messageId, status] of statusById) {
    if (status === 'pin') merged.pinned.push(messageId);
    if (status === 'exclude') merged.excluded.push(messageId);
    if (status === 'retain') merged.retained.push(messageId);
  }

  return merged;
}

export function applyInterventionsToTranscript<T extends { id: string }>(
  transcript: readonly T[],
  interventions: ContextInterventionSnapshot,
): T[] {
  const byId = new Map(transcript.map((message) => [message.id, message]));
  const excluded = new Set(interventions.excluded);
  const pinned = interventions.pinned
    .map((messageId) => byId.get(messageId))
    .filter((value): value is T => value !== undefined && !excluded.has(value.id));
  const retained = interventions.retained
    .map((messageId) => byId.get(messageId))
    .filter((value): value is T => value !== undefined && !excluded.has(value.id));
  const base = transcript.filter((message) => !excluded.has(message.id));
  const seen = new Set<string>();

  return [...pinned, ...retained, ...base].filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

let contextInterventionStateSingleton: ContextInterventionState | null = null;

export function getContextInterventionState(): ContextInterventionState {
  if (!contextInterventionStateSingleton) {
    contextInterventionStateSingleton = new ContextInterventionState();
  }
  return contextInterventionStateSingleton;
}

