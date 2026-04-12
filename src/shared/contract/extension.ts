// ============================================================================
// Extension Types - Unified extension management
// ============================================================================

export type ExtensionType = 'plugin' | 'skill' | 'command';
export type ExtensionStatus = 'active' | 'inactive' | 'error' | 'disabled' | 'not_installed';
export type ExtensionSource = 'local' | 'marketplace' | 'builtin';

export interface ExtensionInfo {
  id: string;
  name: string;
  type: ExtensionType;
  status: ExtensionStatus;
  source: ExtensionSource;
  version?: string;
  description?: string;
  error?: string;
  marketplace?: string;
}
