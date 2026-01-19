// ============================================================================
// Sync Types
// ============================================================================

export interface SyncStatus {
  isEnabled: boolean;
  isSyncing: boolean;
  lastSyncAt: number | null;
  pendingChanges: number;
  syncProgress?: {
    phase: 'pull' | 'push' | 'done';
    current: number;
    total: number;
  };
  error?: string;
}

export interface SyncConflict {
  id: string;
  table: string;
  localRecord: unknown;
  remoteRecord: unknown;
  conflictType: 'update' | 'delete';
}

// DeviceInfo is exported from ./device.ts
