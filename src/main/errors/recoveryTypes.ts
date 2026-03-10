// ============================================================================
// Recovery Types - Shared types for recovery engine and learner
// ============================================================================
// Extracted to break circular dependency between recoveryEngine ↔ recoveryLearner.

export enum RecoveryAction {
  AUTO_RETRY = 'auto_retry',
  OPEN_SETTINGS = 'open_settings',
  AUTO_COMPACT = 'auto_compact',
  AUTO_SWITCH_PROVIDER = 'auto_switch_provider',
  NOTIFY_ONLY = 'notify_only',
}

export interface ErrorRecoveryEvent {
  errorCode: string;
  userMessage: string;
  recoveryAction: RecoveryAction;
  recoveryStatus: 'pending' | 'in_progress' | 'succeeded' | 'failed';
  metadata?: Record<string, unknown>;
  timestamp: number;
}

export interface RecoveryContext {
  onRetry?: () => Promise<void>;
  onCompact?: () => Promise<void>;
  onSwitchProvider?: (fallbackProvider: string) => Promise<void>;
}
