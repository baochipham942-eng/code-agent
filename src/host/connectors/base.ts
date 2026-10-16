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
  // 授权通过但最近一次探测拿到的账号/日历/列表为空（邮件无账号等）。结构化信号，
  // 供渲染层区分「已连接」与「连上了但还没内容」——detail 在 ready 分支是固定文案，
  // 真实描述只出现在被 IPC 层丢弃的 execute summary 里，不能靠文案匹配。
  noAccessibleItems?: boolean;
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
