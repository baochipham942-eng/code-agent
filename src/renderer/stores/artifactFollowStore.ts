import { create } from 'zustand';

export interface ArtifactFollowEntry {
  sessionId: string;
  path: string;
  phase: 'generating' | 'complete';
  attention: boolean;
  startedAt: number;
  completedAt?: number;
}

interface ArtifactFollowState {
  entries: Record<string, ArtifactFollowEntry>;
  pausedSessionIds: Set<string>;
  start: (input: Omit<ArtifactFollowEntry, 'phase' | 'startedAt'> & { startedAt?: number }) => void;
  complete: (sessionId: string, path: string, completedAt?: number) => void;
  clearAttention: (sessionId: string, path: string) => void;
  setSessionPaused: (sessionId: string, paused: boolean) => void;
  reset: () => void;
}

export function artifactFollowKey(sessionId: string, path: string): string {
  return `${sessionId}\u0000${path}`;
}

export const useArtifactFollowStore = create<ArtifactFollowState>((set) => ({
  entries: {},
  pausedSessionIds: new Set(),
  start: (input) => set((state) => {
    const key = artifactFollowKey(input.sessionId, input.path);
    return {
      entries: {
        ...state.entries,
        [key]: {
          sessionId: input.sessionId,
          path: input.path,
          phase: 'generating',
          attention: input.attention,
          startedAt: input.startedAt ?? Date.now(),
        },
      },
    };
  }),
  complete: (sessionId, path, completedAt = Date.now()) => set((state) => {
    const key = artifactFollowKey(sessionId, path);
    const existing = state.entries[key];
    if (!existing) return state;
    return {
      entries: {
        ...state.entries,
        [key]: { ...existing, phase: 'complete', completedAt },
      },
    };
  }),
  clearAttention: (sessionId, path) => set((state) => {
    const key = artifactFollowKey(sessionId, path);
    const existing = state.entries[key];
    if (!existing?.attention) return state;
    return {
      entries: {
        ...state.entries,
        [key]: { ...existing, attention: false },
      },
    };
  }),
  setSessionPaused: (sessionId, paused) => set((state) => {
    const next = new Set(state.pausedSessionIds);
    if (paused) next.add(sessionId);
    else next.delete(sessionId);
    return { pausedSessionIds: next };
  }),
  reset: () => set({ entries: {}, pausedSessionIds: new Set() }),
}));
