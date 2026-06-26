import type { ConnectorLifecycleAction } from '../../shared/ipc';

// ============================================================================
// Connector Base Types - Office connector runtime primitives
// ============================================================================

export interface ConnectorStatus {
  connected: boolean;
  readiness?: 'unchecked' | 'ready' | 'failed' | 'unavailable';
  detail?: string;
  error?: string;
  checkedAt?: number;
  actions?: ConnectorLifecycleAction[];
  capabilities: string[];
}

export interface ConnectorExecutionResult<T = unknown> {
  data: T;
  summary?: string;
}

export interface Connector {
  id: string;
  label: string;
  capabilities: string[];
  getCachedStatus?: () => ConnectorStatus;
  getStatus(): Promise<ConnectorStatus>;
  execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult>;
}
