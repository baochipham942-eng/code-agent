// ============================================================================
// Mode Store - Application Mode State Management (Developer / Cowork)
// ============================================================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  effortLevel: import('../../shared/types/agent').EffortLevel;

  // Interaction mode (Code / Plan / Ask)
  interactionMode: import('../../shared/types/agent').InteractionMode;

  // Pause state
  isPaused: boolean;

  // Actions
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
  setEffortLevel: (level: import('../../shared/types/agent').EffortLevel) => void;
  setInteractionMode: (mode: import('../../shared/types/agent').InteractionMode) => void;
  setIsPaused: (paused: boolean) => void;

  // Derived helpers
  isDeveloperMode: () => boolean;
  isCoworkMode: () => boolean;
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export const useModeStore = create<ModeState>()(
  persist(
    (set, get) => ({
      // Default to cowork mode (only mode)
      mode: 'cowork',

      // Default effort level
      effortLevel: 'high' as import('../../shared/types/agent').EffortLevel,

      // Default interaction mode
      interactionMode: 'code' as import('../../shared/types/agent').InteractionMode,

      // Pause state
      isPaused: false,

      // Set mode (kept for compatibility)
      setMode: (mode) => set({ mode }),

      // Toggle (no-op, only cowork mode now)
      toggleMode: () => {},

      // Set effort level and sync to backend via IPC
      setEffortLevel: (level) => {
        set({ effortLevel: level });
        // Dynamic import to avoid circular dependency at module load time
        import('../services/ipcService').then(({ invokeDomain }) => {
          invokeDomain('domain:agent', 'setEffortLevel', { level }).catch(() => {
            // Silently ignore if agent not initialized yet — will apply on next message
          });
        });
      },

      // Set interaction mode and sync to backend via IPC
      setInteractionMode: (mode) => {
        set({ interactionMode: mode });
        import('../services/ipcService').then(({ invokeDomain }) => {
          invokeDomain('domain:agent', 'setInteractionMode', { mode }).catch(() => {
            // Silently ignore if agent not initialized yet — will apply on next message
          });
        });
      },

      // Set pause state and sync to backend via IPC
      setIsPaused: (paused) => {
        set({ isPaused: paused });
        const action = paused ? 'pause' : 'resume';
        import('../services/ipcService').then(({ invokeDomain }) => {
          invokeDomain('domain:agent', action, {}).catch(() => {
            // Silently ignore if agent not initialized yet
          });
        });
      },

      // Helpers
      isDeveloperMode: () => false,
      isCoworkMode: () => true,
    }),
    {
      name: 'code-agent-mode',
      version: 3, // Bump: added interactionMode
    }
  )
);

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Hook to check if currently in developer mode
 * @deprecated Always returns false, only cowork mode is supported now
 */
export function useIsDeveloperMode(): boolean {
  return false;
}

/**
 * Hook to check if currently in cowork mode
 */
export function useIsCoworkMode(): boolean {
  return useModeStore((state) => state.mode === 'cowork');
}
