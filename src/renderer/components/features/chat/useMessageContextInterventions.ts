import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ContextInterventionAction, ContextInterventionSnapshot } from '@shared/contract/contextView';
import ipcService from '../../../services/ipcService';

const EMPTY: ContextInterventionSnapshot = { pinned: [], excluded: [], retained: [] };

const snapshots = new Map<string, ContextInterventionSnapshot>();
const inflight = new Map<string, Promise<void>>();
const versions = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshotFor(sessionId: string | undefined): ContextInterventionSnapshot {
  if (!sessionId) return EMPTY;
  return snapshots.get(sessionId) ?? EMPTY;
}

function normalize(value: ContextInterventionSnapshot | null | undefined): ContextInterventionSnapshot {
  return {
    pinned: [...(value?.pinned ?? [])],
    excluded: [...(value?.excluded ?? [])],
    retained: [...(value?.retained ?? [])],
  };
}

export function useMessageContextInterventions(sessionId: string | undefined): {
  snapshot: ContextInterventionSnapshot;
  setAction: (messageId: string, action: Extract<ContextInterventionAction, 'pin' | 'exclude'>, enabled: boolean) => Promise<void>;
} {
  const snapshot = useSyncExternalStore(subscribe, () => snapshotFor(sessionId), () => EMPTY);

  useEffect(() => {
    if (!sessionId || snapshots.has(sessionId) || inflight.has(sessionId)) return;
    const versionAtStart = versions.get(sessionId) ?? 0;
    const task = Promise.resolve(
      ipcService.invoke(IPC_CHANNELS.CONTEXT_INTERVENTION_GET, { sessionId }),
    ).then((result) => {
      if ((versions.get(sessionId) ?? 0) !== versionAtStart) return;
      snapshots.set(sessionId, normalize(result));
      emit();
    }).catch(() => {
      if ((versions.get(sessionId) ?? 0) !== versionAtStart) return;
      snapshots.set(sessionId, EMPTY);
      emit();
    }).finally(() => {
      inflight.delete(sessionId);
    });
    inflight.set(sessionId, task);
  }, [sessionId]);

  const setAction = useCallback(async (
    messageId: string,
    action: Extract<ContextInterventionAction, 'pin' | 'exclude'>,
    enabled: boolean,
  ) => {
    if (!sessionId || !messageId) return;
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1);
    const next = await ipcService.invoke(IPC_CHANNELS.CONTEXT_INTERVENTION_SET, {
      sessionId,
      messageId,
      action,
      enabled,
    });
    snapshots.set(sessionId, normalize(next));
    emit();
  }, [sessionId]);

  return { snapshot, setAction };
}

type MessageContextStatus = 'pin' | 'exclude' | null;

export function messageContextStatus(
  snapshot: ContextInterventionSnapshot,
  messageId: string,
): MessageContextStatus {
  if (snapshot.excluded.includes(messageId)) return 'exclude';
  if (snapshot.pinned.includes(messageId)) return 'pin';
  return null;
}

/** Menu id for a trace node. Tool rows and non-final replies get none. */
export function messageContextMenuId(node: {
  id: string;
  type: string;
  messageId?: string;
  feedbackEligible?: boolean;
}): string | null {
  if (node.type === 'user') return node.messageId || node.id;
  if (node.type === 'assistant_text' && node.feedbackEligible) {
    return node.messageId || (node.id.endsWith('-text') ? node.id.slice(0, -5) : node.id);
  }
  return null;
}
