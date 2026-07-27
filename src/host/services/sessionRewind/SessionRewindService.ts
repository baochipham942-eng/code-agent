import type { Message } from '../../../shared/contract/message';
import {
  SessionRewindError,
  type RestoreConversationRewindRequest,
  type RestoreConversationRewindResult,
  type RewindConversationRequest,
  type RewindConversationResult,
} from '../../../shared/contract/sessionRewind';
import type {
  PromptRewindRecordInput,
  PromptRewindRestoreResult,
  PromptRewindResult,
} from '../core/repositories/SessionRepository';

const ACTIVE_RUNTIME_STATES = new Set(['running', 'paused', 'queued', 'cancelling']);

export interface SessionRewindServiceDatabase {
  applyPromptRewind(
    sessionId: string,
    userMessageId: string,
    record?: PromptRewindRecordInput,
  ): PromptRewindResult;
  restorePromptRewind(
    sessionId: string,
    rewindId: string,
    restoredAt?: number,
  ): PromptRewindRestoreResult;
}

export interface SessionRewindServiceOptions {
  getRuntimeStatus?: (sessionId: string) => string | undefined;
  setSessionContext?: (sessionId: string, messages: Message[]) => void;
  now?: () => number;
}

export class SessionRewindService {
  private readonly now: () => number;

  constructor(
    private readonly database: SessionRewindServiceDatabase,
    private readonly options: SessionRewindServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async rewindConversation(request: RewindConversationRequest): Promise<RewindConversationResult> {
    this.assertIdle(request.sessionId);
    if (!request.sessionId.trim() || !request.anchorUserMessageId.trim()) {
      throw new SessionRewindError('INVALID_ANCHOR', 'sessionId and anchorUserMessageId are required');
    }
    if (!request.idempotencyKey.trim()) {
      throw new SessionRewindError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is required');
    }

    let result: PromptRewindResult;
    try {
      result = this.database.applyPromptRewind(
        request.sessionId,
        request.anchorUserMessageId,
        { idempotencyKey: request.idempotencyKey },
      );
    } catch (error) {
      throw this.normalizeError(error);
    }
    this.options.setSessionContext?.(request.sessionId, result.activeMessages);

    return {
      success: true,
      sessionId: request.sessionId,
      rewindId: result.rewindId,
      draft: {
        content: result.anchorMessage.content,
        attachments: result.anchorMessage.attachments,
      },
      activeMessages: result.activeMessages,
      hiddenMessageCount: result.hiddenMessageCount,
      workspaceChanged: false,
      filesRestored: 0,
      filesDeleted: 0,
    };
  }

  async restoreConversation(
    request: RestoreConversationRewindRequest,
  ): Promise<RestoreConversationRewindResult> {
    this.assertIdle(request.sessionId);
    let result: PromptRewindRestoreResult;
    try {
      result = this.database.restorePromptRewind(
        request.sessionId,
        request.rewindId,
        this.now(),
      );
    } catch (error) {
      throw this.normalizeError(error);
    }
    this.options.setSessionContext?.(request.sessionId, result.activeMessages);
    return {
      success: true,
      sessionId: request.sessionId,
      rewindId: request.rewindId,
      restoredMessageCount: result.restoredMessageCount,
      activeMessages: result.activeMessages,
      workspaceChanged: false,
    };
  }

  private assertIdle(sessionId: string): void {
    const status = this.options.getRuntimeStatus?.(sessionId);
    if (status && ACTIVE_RUNTIME_STATES.has(status)) {
      throw new SessionRewindError('SESSION_RUNNING', `session is ${status}`);
    }
  }

  private normalizeError(error: unknown): SessionRewindError {
    if (error instanceof SessionRewindError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('IDEMPOTENCY_CONFLICT')) {
      return new SessionRewindError('IDEMPOTENCY_CONFLICT', message);
    }
    if (message.includes('Active user message not found')) {
      return new SessionRewindError('INVALID_ANCHOR', message);
    }
    if (message.includes('Rewind not found')) {
      return new SessionRewindError('REWIND_NOT_FOUND', message);
    }
    return new SessionRewindError('REWIND_OPERATION_FAILED', message);
  }
}
