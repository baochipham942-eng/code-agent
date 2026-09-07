import type {
  PromptRewindResult,
  RestoreWorkspaceFilesAtCheckpointRequest,
  RestoreWorkspaceFilesAtCheckpointResult,
} from '../../shared/contract/appService';
import type {
  ConversationBoundary,
  ConversationBranchComparison,
  ConversationEvaluationAttribution,
  ConversationLineageAudit,
  ConversationProvenanceTrace,
  ConversationReplay,
} from '../../shared/contract/conversationBranch';
import { WorkspaceFileRestoreError } from '../../shared/contract/fileRestore';
import type {
  CreateSessionForkRequest,
  CreateSessionForkResult,
  SessionForkLineageSummary,
} from '../../shared/contract/sessionFork';
import {
  LOCAL_SESSION_FORK_OWNER_SCOPE_ID,
  type EnqueueSessionForkSyncRequest,
  type ExportSessionForkRequest,
  type ForkNeighborhoodProjection,
  type ForkSearchDocument,
  type ForkTreeNodeProjection,
  type ImportReadySessionForkSyncRequest,
  type ImportReadySessionForkSyncResponse,
  type ImportSessionForkRequest,
  type ImportSessionForkResponse,
  type IngestSessionForkSyncRequest,
  type ReadSessionForkNeighborhoodRequest,
  type ReadSessionForkTreeRequest,
  type SearchSessionForkExportsRequest,
  type SessionExportEnvelopeV2,
  type SessionForkSyncEnvelopeRecord,
} from '../../shared/contract/sessionForkPortability';
import {
  SessionRewindError,
  type RestoreConversationRewindRequest,
  type RestoreConversationRewindResult,
  type RewindConversationRequest,
  type RewindConversationResult,
} from '../../shared/contract/sessionRewind';
import type {
  TurnCheckoutRequest,
  TurnCheckoutResult,
  TurnRedoRequest,
  TurnRedoResult,
} from '../../shared/contract/turnCheckout';
import type { SystemEventMessageMetadata } from '../../shared/contract/systemEventRegistry';
import { v4 as uuidv4 } from 'uuid';
import type { TaskManager } from '../task';
import { getContextHealthService } from '../context/contextHealthService';
import { getAuthService } from '../services/auth/authService';
import { getFileCheckpointService } from '../services/checkpoint';
import { invalidateSessionEvidence } from '../services/checkpoint/evidenceInvalidationService';
import { TurnCheckoutService } from '../services/checkpoint/turnCheckoutService';
import { getDatabase } from '../services/core/databaseService';
import { getProjectSourceGitStates } from '../services/git/gitStatusService';
import { getSessionManager } from '../services/infra/sessionManager';
import { createLogger } from '../services/infra/logger';
import { getProjectService } from '../services/project/projectService';
import { SessionForkService } from '../services/sessionFork/SessionForkService';
import { planSessionForkImport } from '../services/sessionFork/portability';
import type {
  TrustedSingleRootGitProjectWorkspace,
} from '../services/sessionFork/workspace';
import { SessionRewindService } from '../services/sessionRewind/SessionRewindService';
import type { DurableRunReadService } from './durableRunReadService';

const FILE_RESTORE_ACTIVE_RUN_STATES = new Set([
  'created',
  'running',
  'waiting',
  'paused',
  'queued',
  'cancelling',
  'recovering',
]);
const logger = createLogger('SessionHistoryAppService');
const activeTurnCheckoutSessions = new Set<string>();

async function withTurnCheckoutSessionLock<T>(
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeTurnCheckoutSessions.has(sessionId)) {
    throw new SessionRewindError('SESSION_RUNNING', 'another turn checkout operation is active');
  }
  activeTurnCheckoutSessions.add(sessionId);
  try {
    return await operation();
  } finally {
    activeTurnCheckoutSessions.delete(sessionId);
  }
}

/**
 * Owns the fork, rewind, immutable-history, portability, and explicit workspace
 * restore application flows. AgentAppService keeps the public surface stable
 * and delegates these cohesive session-history operations here.
 */
export class SessionHistoryAppService {
  constructor(
    private readonly getTaskManager: () => TaskManager,
    private readonly durableRunReadService?: DurableRunReadService,
  ) {}

  async forkSession(params: CreateSessionForkRequest): Promise<CreateSessionForkResult> {
    const database = getDatabase();
    const taskManager = this.getTaskManager();
    const service = new SessionForkService(database, {
      getRuntimeStatus: (sessionId) => taskManager.getSessionState(sessionId).status,
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    });
    const result = await service.createFork(params);
    getContextHealthService().cleanup(result.childSession.id);
    if (result.lineage.contextDeliveryMode === 'neo_native_prefix') {
      taskManager.setSessionContext(
        result.childSession.id,
        database.getMessages(result.childSession.id),
      );
    }
    return result;
  }

  async getForkLineage(sessionId: string): Promise<SessionForkLineageSummary | null> {
    return new SessionForkService(getDatabase(), {
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    }).getLineage(sessionId);
  }

  async listForkChildren(sessionId: string): Promise<SessionForkLineageSummary[]> {
    return new SessionForkService(getDatabase(), {
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    }).listChildren(sessionId);
  }

  async exportSessionFork(params: ExportSessionForkRequest): Promise<SessionExportEnvelopeV2> {
    const boundary = this.requireConversationBoundary(params.sessionId);
    if (!boundary.projectId) {
      throw new Error(`PROJECT_ACCESS_DENIED: session ${params.sessionId} has no canonical project`);
    }
    return getDatabase().exportSessionFork({
      exportId: params.exportId,
      rootSessionId: params.sessionId,
      ownerScopeId: this.currentSessionForkOwnerScope(),
      projectId: boundary.projectId,
      mode: params.mode,
    });
  }

  async importSessionFork(params: ImportSessionForkRequest): Promise<ImportSessionForkResponse> {
    const database = getDatabase();
    const ownerUserId = getAuthService().getCurrentUser()?.id ?? null;
    const ownerScopeId = ownerUserId ?? LOCAL_SESSION_FORK_OWNER_SCOPE_ID;
    const targetProjectId = this.requireSessionForkProject(params.targetProjectId);
    const plan = planSessionForkImport({
      envelope: params.envelope,
      targetOwnerScopeId: ownerScopeId,
      targetProjectId,
      namespace: params.namespace,
      allowProjectRemap: params.allowProjectRemap,
    });
    const result = database.importSessionFork({
      envelope: params.envelope,
      targetOwnerScopeId: ownerScopeId,
      targetProjectId,
      namespace: params.namespace,
      allowProjectRemap: params.allowProjectRemap,
    });

    try {
      const isolatedSessions = plan.envelope.sessions
        .filter((session) => session.workspace?.mode === 'isolated_at_anchor')
        .map((session) => {
          const sourceSessionId = Object.entries(plan.sessionIdMap)
            .find(([, importedSessionId]) => importedSessionId === session.id)?.[0];
          const importedSessionId = sourceSessionId
            ? result.sessionIdMap[sourceSessionId]
            : undefined;
          const portableEvidence = session.workspace?.isolatedAnchor;
          const importedAnchorMessageId = session.workspace?.anchorChildMessageId;
          if (
            !sourceSessionId
            || importedSessionId !== session.id
            || !importedAnchorMessageId
            || !portableEvidence
          ) {
            throw new Error(
              `IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: isolated session ${session.id} `
              + 'requires its remapped child anchor and complete portable evidence',
            );
          }
          return {
            importedSessionId,
            importedAnchorMessageId,
            portableEvidence,
          };
        })
        .sort((left, right) => left.importedSessionId.localeCompare(right.importedSessionId));

      if (isolatedSessions.length > 0) {
        const workspaceBinding = await this.requireImportedWorkspaceBinding(targetProjectId);
        const preparedWorkspaces = [];
        for (const isolated of isolatedSessions) {
          preparedWorkspaces.push(await database.prepareImportedIsolatedWorkspace({
            ...isolated,
            ownerUserId,
            targetProjectId,
            workspaceBinding,
          }));
        }
        await database.publishPreparedImportedWorkspaceGraph({
          importId: result.importId,
          sourceExportId: plan.sourceExportId,
          sourcePayloadDigest: plan.envelope.payloadDigest,
          ownerUserId,
          targetProjectId,
          sessions: plan.envelope.sessions.map((session) => ({
            sessionId: session.id,
            readOnly: session.workspace?.mode === 'isolated_at_anchor'
              ? false
              : Boolean(session.readOnly),
            workspaceMode: session.workspace?.mode ?? 'shared_current',
          })),
          workspaces: preparedWorkspaces,
        });
      }
      return result;
    } finally {
      for (const sessionId of Object.values(result.sessionIdMap)) {
        getSessionManager().invalidateSessionCache(sessionId);
      }
    }
  }

  async enqueueSessionForkSync(
    params: EnqueueSessionForkSyncRequest,
  ): Promise<SessionForkSyncEnvelopeRecord> {
    const ownerScopeId = this.currentSessionForkOwnerScope();
    const projectId = this.requireSessionForkProject(params.projectId);
    const envelope = getDatabase().getDurableSessionForkExport(
      params.exportId,
      ownerScopeId,
      projectId,
    );
    if (!envelope) {
      throw new Error(`SYNC_ENVELOPE_NOT_FOUND: export ${params.exportId} does not exist`);
    }
    return getDatabase().enqueueSessionForkOutbound({
      syncEnvelopeId: params.syncEnvelopeId,
      envelope,
      dependencyIds: params.dependencyIds ?? [],
      ownerScopeId,
      projectId,
    });
  }

  async ingestSessionForkSync(
    params: IngestSessionForkSyncRequest,
  ): Promise<SessionForkSyncEnvelopeRecord> {
    return getDatabase().ingestSessionForkInbound({
      wire: params.wire,
      ownerScopeId: this.currentSessionForkOwnerScope(),
      projectId: this.requireSessionForkProject(params.targetProjectId),
    });
  }

  async importReadySessionForkSync(
    params: ImportReadySessionForkSyncRequest,
  ): Promise<ImportReadySessionForkSyncResponse> {
    const ownerScopeId = this.currentSessionForkOwnerScope();
    const projectId = this.requireSessionForkProject(params.targetProjectId);
    const record = getDatabase().getSessionForkSyncRecord(
      'inbox',
      params.syncEnvelopeId,
      ownerScopeId,
      projectId,
    );
    if (!record) {
      throw new Error(`SYNC_ENVELOPE_NOT_FOUND: inbox ${params.syncEnvelopeId} does not exist`);
    }
    if (record.state !== 'ready' && record.state !== 'applied') {
      throw new Error(`ENVELOPE_NOT_READY: inbox ${params.syncEnvelopeId} is ${record.state}`);
    }
    const imported = await this.importSessionFork({
      envelope: record.envelope,
      targetProjectId: projectId,
      namespace: params.namespace,
      allowProjectRemap: false,
    });
    const sync = record.state === 'applied'
      ? record
      : getDatabase().applySessionForkInbound(
        params.syncEnvelopeId,
        ownerScopeId,
        projectId,
      );
    return { sync, imported };
  }

  async searchSessionForkExports(params: SearchSessionForkExportsRequest): Promise<ForkSearchDocument[]> {
    const projectId = this.requireSessionForkProject(params.projectId);
    return getDatabase().searchDurableSessionForks(
      params.exportId,
      this.currentSessionForkOwnerScope(),
      projectId,
      params.query,
    );
  }

  async readSessionForkTree(params: ReadSessionForkTreeRequest): Promise<ForkTreeNodeProjection> {
    const projectId = this.requireSessionForkProject(params.projectId);
    return getDatabase().getDurableSessionForkTree(
      params.exportId,
      this.currentSessionForkOwnerScope(),
      projectId,
    );
  }

  async readSessionForkNeighborhood(
    params: ReadSessionForkNeighborhoodRequest,
  ): Promise<ForkNeighborhoodProjection> {
    const projectId = this.requireSessionForkProject(params.projectId);
    return getDatabase().getDurableSessionForkNeighborhood(
      params.exportId,
      this.currentSessionForkOwnerScope(),
      projectId,
      params.centerSessionId,
      params.radius,
    );
  }

  async replayConversationBranch(
    sessionId: string,
    options?: { includeRewound?: boolean; allowRepairOverride?: boolean },
  ): Promise<ConversationReplay> {
    return getDatabase().replayConversationBranch(
      sessionId,
      this.requireConversationBoundary(sessionId),
      options,
    );
  }

  async compareConversationBranches(
    leftSessionId: string,
    rightSessionId: string,
  ): Promise<ConversationBranchComparison> {
    const boundary = this.requireConversationBoundary(leftSessionId);
    const rightBoundary = this.requireConversationBoundary(rightSessionId);
    if (
      boundary.ownerUserId !== rightBoundary.ownerUserId
      || boundary.projectId !== rightBoundary.projectId
    ) {
      throw new Error('PROJECT_MISMATCH: conversation branches must share one exact owner and project');
    }
    return getDatabase().compareConversationBranches(leftSessionId, rightSessionId, boundary);
  }

  async traceConversationProvenance(
    sessionId: string,
    messageId: string,
  ): Promise<ConversationProvenanceTrace> {
    return getDatabase().traceConversationProvenance(
      sessionId,
      messageId,
      this.requireConversationBoundary(sessionId),
    );
  }

  async auditConversationLineage(sessionId: string): Promise<ConversationLineageAudit> {
    return getDatabase().auditConversationLineage(
      sessionId,
      this.requireConversationBoundary(sessionId),
    );
  }

  async quarantineConversationLineage(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<ConversationLineageAudit> {
    return getDatabase().quarantineConversationLineage(
      sessionId,
      this.requireConversationBoundary(sessionId),
      idempotencyKey,
    );
  }

  async repairConversationLineage(params: {
    sessionId: string;
    issueDigest: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<ConversationLineageAudit> {
    return getDatabase().repairConversationLineage({
      ...params,
      boundary: this.requireConversationBoundary(params.sessionId),
    });
  }

  async recordConversationEvaluationAttribution(params: {
    sessionId: string;
    evaluationId: string;
    runId?: string | null;
    metric: string;
    value: number;
    attributedMessageIds: string[];
    idempotencyKey: string;
  }): Promise<ConversationEvaluationAttribution> {
    return getDatabase().recordConversationEvaluationAttribution({
      ...params,
      boundary: this.requireConversationBoundary(params.sessionId),
    });
  }

  async listConversationEvaluationAttributions(
    sessionId: string,
  ): Promise<ConversationEvaluationAttribution[]> {
    return getDatabase().listConversationEvaluationAttributions(
      sessionId,
      this.requireConversationBoundary(sessionId),
    );
  }

  async rewindConversation(params: RewindConversationRequest): Promise<RewindConversationResult> {
    const taskManager = this.getTaskManager();
    const result = await new SessionRewindService(getDatabase(), {
      getRuntimeStatus: (sessionId) => taskManager.getSessionState(sessionId).status,
      setSessionContext: (sessionId, messages) => taskManager.setSessionContext(sessionId, messages),
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    }).rewindConversation(params);
    getSessionManager().invalidateSessionCache(params.sessionId);
    getContextHealthService().cleanup(params.sessionId);
    return result;
  }

  async restoreWorkspaceFilesAtCheckpoint(
    params: RestoreWorkspaceFilesAtCheckpointRequest,
  ): Promise<RestoreWorkspaceFilesAtCheckpointResult> {
    const sessionId = params.sessionId?.trim();
    const checkpointMessageId = params.checkpointMessageId?.trim();
    if (!sessionId || !checkpointMessageId) {
      throw new WorkspaceFileRestoreError(
        'INVALID_FILE_RESTORE_REQUEST',
        'sessionId and checkpointMessageId are required',
      );
    }

    await this.assertWorkspaceMutationAllowed(sessionId);

    const checkpointService = getFileCheckpointService();
    const checkpoints = await checkpointService.getCheckpoints(sessionId);
    if (!checkpoints.some((checkpoint) => checkpoint.messageId === checkpointMessageId)) {
      throw new WorkspaceFileRestoreError(
        'CHECKPOINT_NOT_FOUND',
        `checkpoint anchor ${checkpointMessageId} was not found in session ${sessionId}`,
      );
    }

    const result = await checkpointService.rewindFiles(sessionId, checkpointMessageId);
    if (!result.success || result.errors.length > 0) {
      const failedFileCount = result.errors.length + result.skippedFiles.length;
      throw new WorkspaceFileRestoreError(
        'WORKSPACE_FILE_RESTORE_FAILED',
        `workspace file restore failed or skipped ${failedFileCount} file(s)`,
        result.restoredFiles.length,
        result.deletedFiles.length,
        failedFileCount,
      );
    }

    return {
      success: true,
      sessionId,
      checkpointMessageId,
      restoredFileCount: result.restoredFiles.length,
      deletedFileCount: result.deletedFiles.length,
      workspaceChanged: result.restoredFiles.length + result.deletedFiles.length > 0,
      conversationChanged: false,
    };
  }

  async turnCheckout(params: TurnCheckoutRequest): Promise<TurnCheckoutResult> {
    const sessionId = params.sessionId?.trim();
    const userMessageId = params.userMessageId?.trim();
    if (!sessionId || !userMessageId) {
      throw new WorkspaceFileRestoreError(
        'INVALID_FILE_RESTORE_REQUEST',
        'sessionId and userMessageId are required',
      );
    }
    return withTurnCheckoutSessionLock(sessionId, async () => {
    await this.assertWorkspaceMutationAllowed(sessionId);
    const database = getDatabase();
    const sqlite = database.getDb();
    if (!sqlite) {
      throw new WorkspaceFileRestoreError(
        'WORKSPACE_FILE_RESTORE_FAILED',
        'database is not initialized',
      );
    }
    const anchor = database.getMessages(sessionId).find((message) => (
      message.id === userMessageId && message.role === 'user'
    ));
    if (!anchor) {
      throw new WorkspaceFileRestoreError(
        'CHECKPOINT_NOT_FOUND',
        `active user message ${userMessageId} was not found in session ${sessionId}`,
      );
    }
    const checkpointService = getFileCheckpointService();
    const checkpoint = await checkpointService.getFirstCheckpointAtOrAfter(
      sessionId,
      anchor.timestamp,
    );
    const taskManager = this.getTaskManager();
    const rewindService = new SessionRewindService(database, {
      getRuntimeStatus: (id) => taskManager.getSessionState(id).status,
      setSessionContext: (id, messages) => taskManager.setSessionContext(id, messages),
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    });
    const service = new TurnCheckoutService({
      rewindFiles: (id, messageId, options) => checkpointService.rewindFiles(id, messageId, options),
      redoFiles: (id, messageId, restoredFrom) => checkpointService.redoFiles(id, messageId, restoredFrom),
      rewindConversation: (request, record) => rewindService.rewindConversation(request, record),
      restoreConversation: (request) => rewindService.restoreConversation(request),
      invalidateEvidence: async (id, paths) => invalidateSessionEvidence(sqlite, id, paths),
      writeNote: (id, note) => this.writeTurnCheckoutNote(id, note),
    });
    const result = await service.checkout(
      { ...params, sessionId, userMessageId },
      checkpoint?.messageId ?? null,
    );
    this.refreshTurnCheckoutProjection(sessionId, result.activeMessages);
    return result;
    });
  }

  async turnRedo(params: TurnRedoRequest): Promise<TurnRedoResult> {
    const sessionId = params.sessionId?.trim();
    const rewindId = params.rewindId?.trim();
    if (!sessionId || !rewindId) {
      throw new WorkspaceFileRestoreError(
        'INVALID_FILE_RESTORE_REQUEST',
        'sessionId and rewindId are required',
      );
    }
    return withTurnCheckoutSessionLock(sessionId, async () => {
    await this.assertWorkspaceMutationAllowed(sessionId);
    const database = getDatabase();
    const sqlite = database.getDb();
    if (!sqlite) {
      throw new WorkspaceFileRestoreError(
        'WORKSPACE_FILE_RESTORE_FAILED',
        'database is not initialized',
      );
    }
    const ownerUserId = getAuthService().getCurrentUser()?.id ?? null;
    const audit = database.getPromptRewindAudit(sessionId, rewindId, ownerUserId);
    if (audit.status === 'restored') {
      return {
        success: true,
        state: 'success',
        sessionId,
        rewindId,
        done: [],
        failed: [],
        skippedFiles: [],
        restoredFiles: [],
        deletedFiles: [],
        activeMessages: database.getMessages(sessionId),
        restoredMessageCount: 0,
        staleEvidenceCount: 0,
        redoAvailable: false,
        externalSideEffectsWarning: 'Changes caused by external commands are not rolled back.',
      };
    }
    if (!audit.isLatestCompleted) {
      throw new SessionRewindError(
        'REWIND_OPERATION_FAILED',
        audit.status === 'completed'
          ? 'a newer rewind must be restored first'
          : `rewind cannot be restored from status ${audit.status}`,
      );
    }
    const checkpointService = getFileCheckpointService();
    const taskManager = this.getTaskManager();
    const rewindService = new SessionRewindService(database, {
      getRuntimeStatus: (id) => taskManager.getSessionState(id).status,
      setSessionContext: (id, messages) => taskManager.setSessionContext(id, messages),
      ownerUserId,
    });
    const service = new TurnCheckoutService({
      rewindFiles: (id, messageId, options) => checkpointService.rewindFiles(id, messageId, options),
      redoFiles: (id, messageId, restoredFrom) => checkpointService.redoFiles(id, messageId, restoredFrom),
      rewindConversation: (request, record) => rewindService.rewindConversation(request, record),
      restoreConversation: (request) => rewindService.restoreConversation(request),
      invalidateEvidence: async (id, paths) => invalidateSessionEvidence(sqlite, id, paths),
      writeNote: (id, note) => this.writeTurnCheckoutNote(id, note),
    });
    const result = await service.redo(
      { sessionId, rewindId },
      audit.redoCheckpointMessageId,
    );
    this.refreshTurnCheckoutProjection(sessionId, result.activeMessages);
    return result;
    });
  }

  async restoreConversationRewind(
    params: RestoreConversationRewindRequest,
  ): Promise<RestoreConversationRewindResult> {
    const taskManager = this.getTaskManager();
    const result = await new SessionRewindService(getDatabase(), {
      getRuntimeStatus: (sessionId) => taskManager.getSessionState(sessionId).status,
      setSessionContext: (sessionId, messages) => taskManager.setSessionContext(sessionId, messages),
      ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
    }).restoreConversation(params);
    getSessionManager().invalidateSessionCache(params.sessionId);
    getContextHealthService().cleanup(params.sessionId);
    return result;
  }

  async rewindToPrompt(
    params: { sessionId: string; userMessageId: string; idempotencyKey?: string },
  ): Promise<PromptRewindResult> {
    return this.rewindConversation({
      sessionId: params.sessionId,
      anchorUserMessageId: params.userMessageId,
      idempotencyKey: params.idempotencyKey ?? `legacy:${params.sessionId}:${params.userMessageId}`,
    });
  }

  private async writeTurnCheckoutNote(
    sessionId: string,
    note: NonNullable<import('../../shared/contract').MessageMetadata['turnCheckoutNote']>,
  ): Promise<import('../../shared/contract').Message[]> {
    const action = note.operation === 'checkout' ? 'Turn checkout' : 'Turn Redo';
    const detail = note.failed.map((item) => (
      `${item.step}${item.filePath ? `:${item.filePath}` : ''}: ${item.reason}`
    )).join(' | ');
    const content = `${action} ${note.state}; ${note.changedFileCount} workspace file(s) changed.`
      + `${detail ? ` Failed: ${detail}.` : ''} ${note.externalSideEffectsWarning}`;
    await getSessionManager().addMessageToSession(sessionId, {
      id: `turn-checkout-note-${Date.now()}-${uuidv4().slice(0, 8)}`,
      role: 'system',
      content,
      timestamp: Date.now(),
      metadata: {
        turnCheckoutNote: note,
      } satisfies SystemEventMessageMetadata,
    });
    return getDatabase().getMessages(sessionId);
  }

  private refreshTurnCheckoutProjection(
    sessionId: string,
    activeMessages: import('../../shared/contract').Message[],
  ): void {
    if (activeMessages.length > 0) {
      try {
        this.getTaskManager().setSessionContext(sessionId, activeMessages);
      } catch (error) {
        logger.warn('Committed turn checkout could not refresh task projection', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      getSessionManager().invalidateSessionCache(sessionId);
      getContextHealthService().cleanup(sessionId);
    } catch (error) {
      logger.warn('Committed turn checkout could not invalidate derived caches', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async assertWorkspaceMutationAllowed(sessionId: string): Promise<void> {
    const ownerUserId = getAuthService().getCurrentUser()?.id ?? null;
    const session = getDatabase().getSession(sessionId, { userId: ownerUserId });
    if (!session) {
      throw new WorkspaceFileRestoreError(
        'SESSION_ACCESS_DENIED',
        `session ${sessionId} was not found for the current owner`,
      );
    }
    const runtimeStatus = this.getTaskManager().getSessionState(sessionId)?.status ?? 'idle';
    if (
      FILE_RESTORE_ACTIVE_RUN_STATES.has(String(runtimeStatus))
      || FILE_RESTORE_ACTIVE_RUN_STATES.has(String(session.status ?? 'idle'))
    ) {
      throw new WorkspaceFileRestoreError('SESSION_RUNNING', `session ${sessionId} is active`);
    }
    if (!this.durableRunReadService) return;
    const durable = await this.durableRunReadService.readSessionReplay(sessionId, () => ({
      status: runtimeStatus === 'queued'
        ? 'created'
        : runtimeStatus === 'cancelling'
          ? 'running'
          : runtimeStatus === 'error'
            ? 'failed'
            : runtimeStatus,
      updatedAt: session.updatedAt,
    }));
    if (FILE_RESTORE_ACTIVE_RUN_STATES.has(String(durable.status))) {
      throw new WorkspaceFileRestoreError(
        'SESSION_RUNNING',
        `session ${sessionId} has active durable run ${durable.runId ?? '<unknown>'}`,
      );
    }
  }

  private currentSessionForkOwnerScope(): string {
    return getAuthService().getCurrentUser()?.id ?? LOCAL_SESSION_FORK_OWNER_SCOPE_ID;
  }

  private requireSessionForkProject(projectId: string): string {
    const normalized = projectId.trim();
    if (!normalized || !getDatabase().getProjectRepo().getProject(normalized)) {
      throw new Error(`PROJECT_ACCESS_DENIED: project ${projectId || '<empty>'} was not found`);
    }
    return normalized;
  }

  private async requireImportedWorkspaceBinding(
    projectId: string,
  ): Promise<TrustedSingleRootGitProjectWorkspace> {
    const scope = getProjectService().getWorkspaceScope(projectId);
    if (!scope) {
      throw new Error(
        'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: target Project requires one '
        + 'trusted read-write primary Git workspace',
      );
    }
    const root = scope.roots[0];
    if (
      scope.projectId !== projectId
      || scope.roots.length !== 1
      || root?.role !== 'primary'
      || root.access !== 'read_write'
      || scope.primaryRoot !== root.path
    ) {
      throw new Error(
        'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: target Project requires one '
        + 'trusted read-write primary Git workspace',
      );
    }
    const gitStates = await getProjectSourceGitStates(scope);
    const gitState = gitStates[0];
    if (
      gitStates.length !== 1
      || !gitState?.isRepository
      || gitState.sourceId !== root.sourceId
      || !gitState.repositoryRoot
    ) {
      throw new Error(
        'IMPORTED_WORKSPACE_BOUNDARY_MISMATCH: target Project primary source '
        + 'is not the verified Git repository root',
      );
    }
    return {
      projectId,
      topology: 'single_root_git',
      identityTrust: 'verified',
      repositoryRoot: gitState.repositoryRoot,
      workspaceScopeVersion: scope.version,
    };
  }

  private requireConversationBoundary(sessionId: string): ConversationBoundary {
    const ownerUserId = getAuthService().getCurrentUser()?.id ?? null;
    const session = getDatabase().getSession(sessionId, { userId: ownerUserId });
    if (!session) {
      throw new Error(`SESSION_ACCESS_DENIED: session ${sessionId} was not found for the current owner`);
    }
    return {
      ownerUserId,
      projectId: session.projectId ?? null,
    };
  }
}
