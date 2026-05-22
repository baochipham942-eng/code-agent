// ============================================================================
// Persistence Health Contract
// ============================================================================

export type PersistenceStatus = 'available' | 'unavailable';
export type PersistenceMode = 'database' | 'memory';

export interface PersistenceHealth {
  status: PersistenceStatus;
  mode: PersistenceMode;
  durable: boolean;
  message: string;
  reason?: string;
  checkedAt: number;
}

export interface WebHealthResponse {
  status: 'ok';
  mode: string;
  timestamp: number;
  handlers: number;
  serverRoot: string;
  pid: number;
  tauriBootToken: string | null;
  persistence: PersistenceHealth;
}
