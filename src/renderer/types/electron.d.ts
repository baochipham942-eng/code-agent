// ============================================================================
// Electron API Type Declarations
// ============================================================================

/// <reference types="vite/client" />

import type { ElectronAPI, DomainAPI } from '@shared/ipc';

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    domainAPI?: DomainAPI;
  }
}

export {};
