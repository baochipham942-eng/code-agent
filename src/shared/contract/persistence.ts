// ============================================================================
// Persistence Health Contract
// ============================================================================

import type { RendererServeDecision } from './desktopShell';
import type { BuildInfo } from './buildInfo';

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
  build: BuildInfo | null;
  persistence: PersistenceHealth;
  rendererServe?: RendererServeDecision | null;
}
