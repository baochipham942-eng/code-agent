// ============================================================================
// Connector Base Types - Office connector runtime primitives
// ============================================================================

export interface ConnectorStatus {
  connected: boolean;
  detail?: string;
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
  getStatus(): Promise<ConnectorStatus>;
  execute(action: string, payload: Record<string, unknown>): Promise<ConnectorExecutionResult>;
}
