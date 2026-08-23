import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';

import type {
  RewindResult,
  TurnCheckoutFailure,
  TurnCheckoutRequest,
  TurnCheckoutResult,
  TurnCheckoutStep,
  TurnRedoRequest,
  TurnRedoResult,
  MessageMetadata,
} from '../../../shared/contract';
import type { RewindConversationResult, RestoreConversationRewindResult } from '../../../shared/contract/sessionRewind';
import type { PromptRewindRecordInput } from '../core/repositories/SessionRepository';

const EXTERNAL_SIDE_EFFECTS_WARNING = 'Changes caused by external commands are not rolled back.';

export interface TurnCheckoutServiceDependencies {
  rewindFiles: (
    sessionId: string,
    checkpointMessageId: string,
    options: { redoCheckpointMessageId: string; restoredFrom: string },
  ) => Promise<RewindResult>;
  redoFiles: (
    sessionId: string,
    redoCheckpointMessageId: string,
    restoredFrom: string,
  ) => Promise<RewindResult>;
  rewindConversation: (
    request: { sessionId: string; anchorUserMessageId: string; idempotencyKey: string },
    record: PromptRewindRecordInput,
  ) => Promise<RewindConversationResult>;
  restoreConversation: (
    request: { sessionId: string; rewindId: string },
  ) => Promise<RestoreConversationRewindResult>;
  invalidateEvidence: (
    sessionId: string,
    changedFilePaths: readonly string[],
  ) => Promise<{ staleRefCount: number }>;
  writeNote: (
    sessionId: string,
    note: NonNullable<MessageMetadata['turnCheckoutNote']>,
  ) => Promise<import('../../../shared/contract').Message[]>;
}

function fileFailures(result: RewindResult): TurnCheckoutFailure[] {
  return [
    ...result.errors.map((item) => ({
      step: 'workspace' as const,
      filePath: item.filePath || undefined,
      reason: item.error,
    })),
    ...result.skippedFiles.map((item) => ({
      step: 'workspace' as const,
      filePath: item.filePath,
      reason: `${item.reason}: ${item.detail}`,
    })),
  ];
}

function changedFiles(result: RewindResult): string[] {
  return Array.from(new Set([...result.restoredFiles, ...result.deletedFiles]));
}

function stateFor(failed: readonly TurnCheckoutFailure[]): 'success' | 'partial' {
  return failed.length === 0 ? 'success' : 'partial';
}

function noteSummary(
  operation: 'checkout' | 'redo',
  done: readonly TurnCheckoutStep[],
  failed: readonly TurnCheckoutFailure[],
  skippedFiles: RewindResult['skippedFiles'],
  restoredFileCount: number,
): NonNullable<MessageMetadata['turnCheckoutNote']> {
  return {
    operation,
    state: failed.length === 0 ? 'success' : 'partial',
    done: [...done],
    failed: failed.map((item) => ({ ...item })),
    skippedFiles: skippedFiles.map((item) => ({ ...item })),
    changedFileCount: restoredFileCount,
    externalSideEffectsWarning: EXTERNAL_SIDE_EFFECTS_WARNING,
  };
}

export class TurnCheckoutService {
  constructor(private readonly dependencies: TurnCheckoutServiceDependencies) {}

  async checkout(
    request: TurnCheckoutRequest,
    checkpointMessageId: string | null,
  ): Promise<TurnCheckoutResult> {
    const idempotencyKey = request.idempotencyKey?.trim()
      || `turn-checkout:${request.sessionId}:${request.userMessageId}:${uuidv4()}`;
    const operationId = `turn_checkout_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 20)}`;
    const redoCheckpointMessageId = `turn_redo_snapshot_${operationId}`;
    const done: TurnCheckoutStep[] = [];
    const failed: TurnCheckoutFailure[] = [];
    let activeMessages: import('../../../shared/contract').Message[] = [];
    let hiddenMessageCount = 0;
    let rewindId: string | undefined;
    let staleEvidenceCount = 0;

    let fileResult: RewindResult = {
      success: true,
      restoredFiles: [],
      deletedFiles: [],
      skippedFiles: [],
      errors: [],
    };
    if (checkpointMessageId) {
      try {
        fileResult = await this.dependencies.rewindFiles(
          request.sessionId,
          checkpointMessageId,
          { redoCheckpointMessageId, restoredFrom: operationId },
        );
      } catch (error) {
        failed.push({
          step: 'workspace',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const changed = changedFiles(fileResult);
    if (changed.length > 0) done.push('workspace');
    failed.push(...fileFailures(fileResult));

    try {
      const conversation = await this.dependencies.rewindConversation({
        sessionId: request.sessionId,
        anchorUserMessageId: request.userMessageId,
        idempotencyKey,
      }, {
        checkpointMessageId,
        redoCheckpointMessageId: changed.length > 0 ? redoCheckpointMessageId : null,
        filesRestored: fileResult.restoredFiles.length,
        filesDeleted: fileResult.deletedFiles.length,
        errors: failed.map((item) => `${item.filePath ?? item.step}: ${item.reason}`),
      });
      rewindId = conversation.rewindId;
      activeMessages = conversation.activeMessages;
      hiddenMessageCount = conversation.hiddenMessageCount;
      done.push('conversation', 'manifest');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push({
        step: 'conversation',
        reason,
      });
      failed.push({ step: 'manifest', reason: `conversation transaction did not commit: ${reason}` });
    }

    if (rewindId || changed.length > 0) {
      try {
        const evidence = await this.dependencies.invalidateEvidence(request.sessionId, changed);
        staleEvidenceCount = evidence.staleRefCount;
        done.push('evidence');
      } catch (error) {
        failed.push({
          step: 'evidence',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      activeMessages = await this.dependencies.writeNote(
        request.sessionId,
        noteSummary('checkout', done, failed, fileResult.skippedFiles, changed.length),
      );
      done.push('note');
    } catch (error) {
      failed.push({ step: 'note', reason: error instanceof Error ? error.message : String(error) });
    }

    const state = stateFor(failed);
    return {
      success: state === 'success',
      state,
      sessionId: request.sessionId,
      ...(rewindId ? { rewindId } : {}),
      done,
      failed,
      skippedFiles: fileResult.skippedFiles,
      restoredFiles: fileResult.restoredFiles,
      deletedFiles: fileResult.deletedFiles,
      activeMessages,
      hiddenMessageCount,
      staleEvidenceCount,
      redoAvailable: Boolean(rewindId),
      externalSideEffectsWarning: EXTERNAL_SIDE_EFFECTS_WARNING,
    };
  }

  async redo(
    request: TurnRedoRequest,
    redoCheckpointMessageId: string | null,
  ): Promise<TurnRedoResult> {
    const done: TurnCheckoutStep[] = [];
    const failed: TurnCheckoutFailure[] = [];
    let activeMessages: import('../../../shared/contract').Message[] = [];
    let restoredMessageCount = 0;
    let staleEvidenceCount = 0;
    let fileResult: RewindResult = {
      success: true,
      restoredFiles: [],
      deletedFiles: [],
      skippedFiles: [],
      errors: [],
    };

    if (redoCheckpointMessageId) {
      try {
        fileResult = await this.dependencies.redoFiles(
          request.sessionId,
          redoCheckpointMessageId,
          request.rewindId,
        );
        if (changedFiles(fileResult).length > 0) done.push('workspace');
        failed.push(...fileFailures(fileResult));
      } catch (error) {
        failed.push({
          step: 'workspace',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const conversation = await this.dependencies.restoreConversation(request);
      activeMessages = conversation.activeMessages;
      restoredMessageCount = conversation.restoredMessageCount;
      done.push('conversation');
    } catch (error) {
      failed.push({
        step: 'conversation',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const changed = changedFiles(fileResult);
    if (changed.length > 0 || done.includes('conversation')) {
      try {
        const evidence = await this.dependencies.invalidateEvidence(request.sessionId, changed);
        staleEvidenceCount = evidence.staleRefCount;
        done.push('evidence');
      } catch (error) {
        failed.push({
          step: 'evidence',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      activeMessages = await this.dependencies.writeNote(
        request.sessionId,
        noteSummary('redo', done, failed, fileResult.skippedFiles, changed.length),
      );
      done.push('note');
    } catch (error) {
      failed.push({ step: 'note', reason: error instanceof Error ? error.message : String(error) });
    }

    const state = stateFor(failed);
    return {
      success: state === 'success',
      state,
      sessionId: request.sessionId,
      rewindId: request.rewindId,
      done,
      failed,
      skippedFiles: fileResult.skippedFiles,
      restoredFiles: fileResult.restoredFiles,
      deletedFiles: fileResult.deletedFiles,
      activeMessages,
      restoredMessageCount,
      staleEvidenceCount,
      redoAvailable: false,
      externalSideEffectsWarning: EXTERNAL_SIDE_EFFECTS_WARNING,
    };
  }
}
