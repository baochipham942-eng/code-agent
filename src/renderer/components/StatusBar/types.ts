// ============================================================================
// StatusBar Types
// ============================================================================

export type NetworkStatusType = 'online' | 'offline' | 'slow';

export interface ModelIndicatorProps {
  model: string;
}

export interface MessageCounterProps {
  count: number;
}

export interface TokenUsageProps {
  input: number;
  output: number;
  isStreaming?: boolean;
}

export interface CostDisplayProps {
  cost: number;
  isStreaming?: boolean;
}

export interface ContextUsageProps {
  percent: number;
}

export interface SessionDurationProps {
  startTime: number;
}

export interface NetworkStatusProps {
  status: NetworkStatusType;
}

// 扩展的网络状态（带重连信息）
export interface NetworkStateExtended {
  status: 'online' | 'offline' | 'reconnecting';
  reconnectAttempts: number;
  nextReconnectAt: number | null;
  lastOnlineAt: number | null;
}
