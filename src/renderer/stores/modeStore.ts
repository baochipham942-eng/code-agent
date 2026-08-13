// ============================================================================
// Mode Store - Application Mode State Management (Developer / Cowork)
// ============================================================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { normalizeAgentEffortLevel } from '../../shared/effortLevels';
import { invokeDomain } from '../services/ipcService';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Application mode types
 * - cowork: Simplified mode for collaboration with other AI agents (default)
 */
export type AppMode = 'cowork';

interface ModeState {
  // Current mode
  mode: AppMode;

  // Effort level (Adaptive Thinking)
  effortLevel: import('../../shared/contract/agent').EffortLevel;

  // Only an explicit user selection overrides per-message complexity analysis.
  effortLevelExplicit: boolean;

  // Provider thinking switch; effort controls intensity when this is on.
  thinkingEnabled: boolean;

  // Per-turn web search switch (model popup); off = this turn never goes online.
  searchEnabled: boolean;

  // Interaction mode (Code / Plan / Ask)
  interactionMode: import('../../shared/contract/agent').InteractionMode;

  // Pause state
  isPaused: boolean;

  // Actions
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
  setEffortLevel: (level: import('../../shared/contract/agent').EffortLevel) => void;
  setAutomaticEffortLevel: () => void;
  setThinkingEnabled: (enabled: boolean) => void;
  setWebSearchEnabled: (enabled: boolean) => void;
  setInteractionMode: (mode: import('../../shared/contract/agent').InteractionMode) => void;
  setIsPaused: (paused: boolean) => void;

  isCoworkMode: () => boolean;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useModeStore = create<ModeState>()(
  persist(
    (set, _get) => ({
      // Default to cowork mode (only mode)
      mode: 'cowork',

      // Default effort level
      effortLevel: 'high' as import('../../shared/contract/agent').EffortLevel,
      effortLevelExplicit: false,

      // Default provider thinking on for workflow/cowork tasks.
      thinkingEnabled: true,

      // 产品负责人 2026-08-12 拍板：逐轮联网搜索默认开启。
      searchEnabled: true,

      // Default interaction mode
      interactionMode: 'code' as import('../../shared/contract/agent').InteractionMode,

      // Pause state
      isPaused: false,

      // Set mode (kept for compatibility)
      setMode: (mode) => set({ mode }),

      // Toggle (no-op, only cowork mode now)
      toggleMode: () => {},

      // An explicit choice travels with the next conversation envelope.
      setEffortLevel: (level) => {
        const normalizedLevel = normalizeAgentEffortLevel(level);
        set({ effortLevel: normalizedLevel, effortLevelExplicit: true });
      },

      setAutomaticEffortLevel: () => set({ effortLevel: 'high', effortLevelExplicit: false }),

      setThinkingEnabled: (enabled) => {
        set({ thinkingEnabled: enabled });
      },

      setWebSearchEnabled: (enabled) => {
        set({ searchEnabled: enabled });
      },

      // Interaction mode is renderer-only placeholder state.
      setInteractionMode: (mode) => {
        set({ interactionMode: mode });
      },

      // Set pause state and sync to backend via IPC
      setIsPaused: (paused) => {
        set({ isPaused: paused });
        const action = paused ? 'pause' : 'resume';
        invokeDomain('domain:agent', action, {}).catch(() => {
          // Silently ignore if agent not initialized yet
        });
      },

      // Helpers
      isCoworkMode: () => true,
    }),
    {
      name: 'code-agent-mode',
      version: 7, // Bump: explicit effort choice; legacy saved values remain automatic.
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }
        const state = persistedState as Partial<ModeState>;
        return {
          ...state,
          effortLevel: normalizeAgentEffortLevel(state.effortLevel),
          // UI effort previously never reached a real request (analyzer overwrote every turn),
          // so legacy persisted values must remain automatic for zero behavior regression.
          effortLevelExplicit: typeof state.effortLevelExplicit === 'boolean'
            ? state.effortLevelExplicit
            : false,
          thinkingEnabled: typeof state.thinkingEnabled === 'boolean'
            ? state.thinkingEnabled
            : true,
          searchEnabled: typeof state.searchEnabled === 'boolean'
            ? state.searchEnabled
            : true,
        };
      },
    }
  )
);

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Hook to check if currently in cowork mode
 */
export function useIsCoworkMode(): boolean {
  return useModeStore((state) => state.mode === 'cowork');
}
