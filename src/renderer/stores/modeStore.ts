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
 * - developer: Full detail mode for developers (default)
 * - cowork: Simplified mode for collaboration with other AI agents
 */
export type AppMode = 'developer' | 'cowork';

interface ModeState {
  // Current mode
  mode: AppMode;

  // Actions
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;

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
      // Default to developer mode
      mode: 'developer',

      // Set mode
      setMode: (mode) => set({ mode }),

      // Toggle between modes
      toggleMode: () =>
        set((state) => ({
          mode: state.mode === 'developer' ? 'cowork' : 'developer',
        })),

      // Helpers
      isDeveloperMode: () => get().mode === 'developer',
      isCoworkMode: () => get().mode === 'cowork',
    }),
    {
      name: 'code-agent-mode',
      version: 1,
    }
  )
);

// -----------------------------------------------------------------------------
// Convenience Hooks
// -----------------------------------------------------------------------------

/**
 * Hook to check if currently in developer mode
 */
export function useIsDeveloperMode(): boolean {
  return useModeStore((state) => state.mode === 'developer');
}

/**
 * Hook to check if currently in cowork mode
 */
export function useIsCoworkMode(): boolean {
  return useModeStore((state) => state.mode === 'cowork');
}
