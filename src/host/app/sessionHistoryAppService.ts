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
import type {
  RestoreConversationRewindRequest,
  RestoreConversationRewindResult,
  RewindConversationRequest,
  RewindConversationResult,
} from '../../shared/contract/sessionRewind';
import type { TaskManager } from '../task';
import { getAuthService } from '../services/auth/authService';
import { getFileCheckpointService } from '../services/checkpoint';
import { getDatabase } from '../services/core/databaseService';
import { getSessionManager } from '../services/infra/sessionManager';
import { SessionForkService } from '../services/sessionFork/SessionForkService';
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
    const result = getDatabase().importSessionFork({
      envelope: params.envelope,
      targetOwnerScopeId: this.currentSessionForkOwnerScope(),
      targetProjectId: this.requireSessionForkProject(params.targetProjectId),
      namespace: params.namespace,
      allowProjectRemap: params.allowProjectRemap,
    });
    for (const sessionId of Object.values(result.sessionIdMap)) {
      getSessionManager().invalidateSessionCache(sessionId);
    }
    return result;
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
      throw new WorkspaceFileRestoreError(
        'SESSION_RUNNING',
        `session ${sessionId} is active`,
      );
    }
    if (this.durableRunReadService) {
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
      throw new WorkspaceFileRestoreError(
        'WORKSPACE_FILE_RESTORE_FAILED',
        `workspace file restore failed for ${result.errors.length} file(s)`,
        result.restoredFiles.length,
        result.deletedFiles.length,
        result.errors.length,
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
