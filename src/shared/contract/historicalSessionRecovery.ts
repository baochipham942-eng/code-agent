export interface HistoricalSessionRecoveryRequest {
  sessionId: string;
  projectId: string | null;
  action: 'inspect' | 'import';
  /** Digest returned by inspect; import never accepts a client-supplied owner. */
  expectedDigest?: string;
}

export interface HistoricalSessionRecoveryResult {
  status: 'ready' | 'imported' | 'already_imported' | 'rejected';
  code: string;
  historyReadable: boolean;
  sourceContinuable: false;
  targetContinuable: boolean;
  continuation?: 'normal_authorization_required';
  sourceDigest?: string;
  recoveryId?: string;
  sessions?: Array<{ sourceSessionId: string; targetSessionId: string; parentSourceSessionId: string | null; messages: number }>;
  changes?: { sessions: number; messages: number; branches: number; entries: number; references: number; events: number; forks: number; forkMessageMappings: number; receipts: number; schemaObjects: number };
}
