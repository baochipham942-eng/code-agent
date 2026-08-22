import type { Message } from './message';
import type { RewindSkippedFile } from './checkpoint';

export type TurnCheckoutStep = 'workspace' | 'conversation' | 'manifest' | 'evidence' | 'note';

export interface TurnCheckoutFailure {
  step: TurnCheckoutStep;
  reason: string;
  filePath?: string;
}

export interface TurnCheckoutRequest {
  sessionId: string;
  userMessageId: string;
  idempotencyKey?: string;
}

export interface TurnRedoRequest {
  sessionId: string;
  rewindId: string;
}

export interface TurnCheckoutResult {
  success: boolean;
  state: 'success' | 'partial';
  sessionId: string;
  rewindId?: string;
  done: TurnCheckoutStep[];
  failed: TurnCheckoutFailure[];
  skippedFiles: RewindSkippedFile[];
  restoredFiles: string[];
  deletedFiles: string[];
  activeMessages: Message[];
  hiddenMessageCount: number;
  staleEvidenceCount: number;
  redoAvailable: boolean;
  /** Honest product boundary: shell/MCP/external side effects are outside file snapshots. */
  externalSideEffectsWarning: string;
}

export interface TurnRedoResult extends Omit<
  TurnCheckoutResult,
  'hiddenMessageCount' | 'staleEvidenceCount' | 'redoAvailable'
> {
  restoredMessageCount: number;
  /** Redo never makes evidence fresh; this counts any stale marks retried during Redo. */
  staleEvidenceCount: number;
  redoAvailable: false;
}
