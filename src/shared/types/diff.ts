// ============================================================================
// Diff Types - 变更追踪共享类型
// ============================================================================

export interface FileDiff {
  id: string;
  sessionId: string;
  messageId: string;
  toolCallId: string;
  filePath: string;
  before: string | null;
  after: string | null;
  unifiedDiff: string;
  stats: {
    additions: number;
    deletions: number;
  };
  timestamp: number;
}

export interface DiffSummary {
  filesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
}
