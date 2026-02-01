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
      // Default to cowork mode (only mode)
      mode: 'cowork',

      // Set mode (kept for compatibility)
      setMode: (mode) => set({ mode }),

      // Toggle (no-op, only cowork mode now)
      toggleMode: () => {},

      // Helpers
      isDeveloperMode: () => false,
      isCoworkMode: () => true,
    }),
    {
      name: 'code-agent-mode',
      version: 2, // Bump version to force migration
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
