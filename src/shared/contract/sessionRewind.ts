import type { Message, MessageAttachment } from './message';

export type SessionRewindErrorCode =
  | 'SESSION_RUNNING'
  | 'INVALID_ANCHOR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REWIND_NOT_FOUND'
  | 'REWIND_OPERATION_FAILED';

export class SessionRewindError extends Error {
  readonly code: SessionRewindErrorCode;

  constructor(code: SessionRewindErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SessionRewindError';
    this.code = code;
  }
}

export interface RewindConversationRequest {
  sessionId: string;
  anchorUserMessageId: string;
  idempotencyKey: string;
}

export interface RewindConversationResult {
  success: true;
  sessionId: string;
  rewindId: string;
  draft: {
    content: string;
    attachments?: MessageAttachment[];
  };
  activeMessages: Message[];
  hiddenMessageCount: number;
  /** Conversation rewind never mutates the workspace. */
  workspaceChanged: false;
  filesRestored: 0;
  filesDeleted: 0;
}

export interface RestoreConversationRewindRequest {
  sessionId: string;
  rewindId: string;
}

export interface RestoreConversationRewindResult {
  success: true;
  sessionId: string;
  rewindId: string;
  restoredMessageCount: number;
  activeMessages: Message[];
  workspaceChanged: false;
}
