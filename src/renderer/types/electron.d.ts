// ============================================================================
// Electron API Type Declarations
// ============================================================================

/// <reference types="vite/client" />

import type { ElectronAPI } from '@shared/ipc';

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
