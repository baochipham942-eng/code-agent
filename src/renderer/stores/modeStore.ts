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

  // Provider thinking switch; effort controls intensity when this is on.
  thinkingEnabled: boolean;

  // Interaction mode (Code / Plan / Ask)
  interactionMode: import('../../shared/contract/agent').InteractionMode;

  // Pause state
  isPaused: boolean;

  // Actions
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
  setEffortLevel: (level: import('../../shared/contract/agent').EffortLevel) => void;
  setThinkingEnabled: (enabled: boolean) => void;
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

      // Default provider thinking on for workflow/cowork tasks.
      thinkingEnabled: true,

      // Default interaction mode
      interactionMode: 'code' as import('../../shared/contract/agent').InteractionMode,

      // Pause state
      isPaused: false,

      // Set mode (kept for compatibility)
      setMode: (mode) => set({ mode }),

      // Toggle (no-op, only cowork mode now)
      toggleMode: () => {},

      // Set effort level and sync to backend via IPC
      setEffortLevel: (level) => {
        const normalizedLevel = normalizeAgentEffortLevel(level);
        set({ effortLevel: normalizedLevel });
        invokeDomain('domain:agent', 'setEffortLevel', { level: normalizedLevel }).catch(() => {
          // Silently ignore if agent not initialized yet — will apply on next message
        });
      },

      setThinkingEnabled: (enabled) => {
        set({ thinkingEnabled: enabled });
        invokeDomain('domain:agent', 'setThinkingEnabled', { enabled }).catch(() => {
          // Silently ignore if agent not initialized yet — will apply on next message
        });
      },

      // Set interaction mode and sync to backend via IPC
      setInteractionMode: (mode) => {
        set({ interactionMode: mode });
        invokeDomain('domain:agent', 'setInteractionMode', { mode }).catch(() => {
          // Silently ignore if agent not initialized yet — will apply on next message
        });
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
      version: 5, // Bump: add independent provider thinking switch.
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return persistedState;
        }
        const state = persistedState as Partial<ModeState>;
        return {
          ...state,
          effortLevel: normalizeAgentEffortLevel(state.effortLevel),
          thinkingEnabled: typeof state.thinkingEnabled === 'boolean'
            ? state.thinkingEnabled
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
