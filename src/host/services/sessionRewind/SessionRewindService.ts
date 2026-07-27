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
import { createLogger } from '../infra/logger';

const ACTIVE_RUNTIME_STATES = new Set(['running', 'paused', 'queued', 'cancelling']);
const logger = createLogger('SessionRewindService');

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
    ownerUserId?: string | null,
  ): PromptRewindRestoreResult;
}

export interface SessionRewindServiceOptions {
  getRuntimeStatus?: (sessionId: string) => string | undefined;
  setSessionContext?: (sessionId: string, messages: Message[]) => void;
  onProjectionFailure?: (
    phase: 'rewind' | 'restore',
    sessionId: string,
    error: unknown,
  ) => void;
  now?: () => number;
  /** `null` explicitly means the local/anonymous owner; `undefined` fails closed. */
  ownerUserId?: string | null;
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
    if (
      typeof request.sessionId !== 'string'
      || typeof request.anchorUserMessageId !== 'string'
      || !request.sessionId.trim()
      || !request.anchorUserMessageId.trim()
    ) {
      throw new SessionRewindError('INVALID_ANCHOR', 'sessionId and anchorUserMessageId are required');
    }
    if (typeof request.idempotencyKey !== 'string' || !request.idempotencyKey.trim()) {
      throw new SessionRewindError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is required');
    }
    const ownerUserId = this.requireOwnerBoundary();
    this.assertIdle(request.sessionId);

    let result: PromptRewindResult;
    try {
      result = this.database.applyPromptRewind(
        request.sessionId,
        request.anchorUserMessageId,
        { idempotencyKey: request.idempotencyKey, ownerUserId },
      );
    } catch (error) {
      throw this.normalizeError(error);
    }
    this.refreshRuntimeProjection('rewind', request.sessionId, result.activeMessages);

    return {
      success: true,
      sessionId: request.sessionId,
      rewindId: result.rewindId,
      draft: {
        content: '',
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
    if (
      typeof request.sessionId !== 'string'
      || typeof request.rewindId !== 'string'
      || !request.sessionId.trim()
      || !request.rewindId.trim()
    ) {
      throw new SessionRewindError('INVALID_ANCHOR', 'sessionId and rewindId are required');
    }
    const ownerUserId = this.requireOwnerBoundary();
    this.assertIdle(request.sessionId);
    let result: PromptRewindRestoreResult;
    try {
      result = this.database.restorePromptRewind(
        request.sessionId,
        request.rewindId,
        this.now(),
        ownerUserId,
      );
    } catch (error) {
      throw this.normalizeError(error);
    }
    this.refreshRuntimeProjection('restore', request.sessionId, result.activeMessages);
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

  /**
   * The SQLite transaction is the durable truth. A stale in-memory projection
   * must never turn a committed rewind into an apparent failure that a client
   * retries with a new idempotency key. Session load/cache invalidation can
   * rebuild this projection from the returned activeMessages.
   */
  private refreshRuntimeProjection(
    phase: 'rewind' | 'restore',
    sessionId: string,
    messages: Message[],
  ): void {
    try {
      this.options.setSessionContext?.(sessionId, messages);
    } catch (error) {
      logger.warn('Committed conversation rewind could not refresh runtime projection', {
        phase,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        this.options.onProjectionFailure?.(phase, sessionId, error);
      } catch {
        // Observability callbacks must not change the committed operation result.
      }
    }
  }

  private requireOwnerBoundary(): string | null {
    const ownerUserId = this.options.ownerUserId;
    if (
      ownerUserId === undefined
      || (typeof ownerUserId === 'string' && ownerUserId.trim().length === 0)
    ) {
      throw new SessionRewindError(
        'REWIND_OPERATION_FAILED',
        'an explicit owner boundary is required',
      );
    }
    return ownerUserId;
  }

  private normalizeError(error: unknown): SessionRewindError {
    if (error instanceof SessionRewindError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('IDEMPOTENCY_CONFLICT')) {
      return new SessionRewindError('IDEMPOTENCY_CONFLICT', message);
    }
    if (message.includes('SESSION_RUNNING')) {
      return new SessionRewindError('SESSION_RUNNING', message);
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
