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
}

export interface CostDisplayProps {
  cost: number;
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
