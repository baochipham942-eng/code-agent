import type { HandlerFn } from '../host/platform';
import { resolveSessionDefaultModelConfig } from '../host/services/core/sessionDefaults';
import type { DurableRunReadService } from '../host/app/durableRunReadService';
import { getModelSessionState } from '../host/session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../host/session/modelOverridePersistence';
import type { ModelProvider, Session } from '../shared/contract';
import { invalidateSessionMessagesProjection } from './helpers/webSessionStore';

type SessionDomainPayload = {
  sessionId?: string;
  provider?: ModelProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  adaptive?: boolean;
  includeArchived?: boolean;
  title?: string;
  workingDirectory?: string;
  userMessageId?: string;
  anchorUserMessageId?: string;
  anchorAssistantMessageId?: string;
  idempotencyKey?: string;
  rewindId?: string;
  checkpointMessageId?: string;
  sourceSessionId?: string;
  workspaceMode?: 'shared_current' | 'isolated_at_anchor';
  updates?: Partial<Session>;
  /** getRecap：上次查看这个会话的时间戳，只追赶它之后收口的轮次 */
  since?: number;
};

type SessionDomainIpcRequest = {
  action: string;
  payload?: SessionDomainPayload;
};

type SessionDomainHandlerDependencies = {
  handlers: Map<string, HandlerFn>;
  getDbAvailable: () => boolean;
  hasActiveRun: (sessionId: string) => boolean;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (sessionId: string) => void;
  getDurableRunReadService: () => DurableRunReadService | undefined;
};

async function createSessionApplicationService(deps: SessionDomainHandlerDependencies) {
  const [{ AgentAppServiceImpl }, { getTaskManager }] = await Promise.all([
    import('../host/app/agentAppService'),
    import('../host/task'),
  ]);
  return new AgentAppServiceImpl(
    () => getTaskManager(),
    () => null,
    deps.getCurrentSessionId,
    deps.setCurrentSessionId,
    undefined,
    deps.getDurableRunReadService(),
  );
}

export function installSessionDomainHandler(deps: SessionDomainHandlerDependencies): void {
  deps.handlers.set('domain:session', async (_event: unknown, request: SessionDomainIpcRequest) => {
    const { action, payload } = request;
    try {
      if (action === 'switchModel') {
        if (!payload?.sessionId || !payload?.provider || !payload?.model) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId, provider and model are required' } };
        }
        const override = {
          provider: payload.provider,
          model: payload.model,
          temperature: payload.temperature,
          maxTokens: payload.maxTokens,
          adaptive: payload.adaptive,
        };
        getModelSessionState().setOverride(payload.sessionId, override);
        const persisted = deps.getDbAvailable()
          ? await persistModelOverride(payload.sessionId, override)
          : false;
        return {
          success: true,
          data: {
            provider: payload.provider,
            model: payload.model,
            adaptive: payload.adaptive,
            persisted,
          },
        };
      }

      if (action === 'getModelOverride') {
        if (!payload?.sessionId) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
        }
        let override = getModelSessionState().getOverride(payload.sessionId);
        if (!override && deps.getDbAvailable()) {
          try {
            const { getSessionManager } = await import('../host/services/infra/sessionManager');
            const session = await getSessionManager().getSession(payload.sessionId, 1);
            override = rehydrateModelOverrideFromSession(session);
          } catch { /* Session missing or DB unavailable: preserve null fallback. */ }
        }
        return { success: true, data: override };
      }

      if (action === 'clearModelOverride') {
        if (!payload?.sessionId) {
          return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
        }
        getModelSessionState().clearOverride(payload.sessionId);
        const cleared = deps.getDbAvailable()
          ? await clearPersistedModelOverride(payload.sessionId)
          : false;
        return { success: true, data: { persisted: cleared } };
      }

      let sm: Awaited<ReturnType<typeof import('../host/services/infra/sessionManager').getSessionManager>> | null = null;
      if (deps.getDbAvailable()) {
        try {
          const { getSessionManager } = await import('../host/services/infra/sessionManager');
          sm = getSessionManager();
        } catch { /* DB not available */ }
      }
      if (!sm) {
        return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'SessionManager not available' } };
      }

      let data: unknown;
      switch (action) {
        case 'list':
          data = await sm.listSessions(payload as { includeArchived?: boolean } | undefined);
          break;
        case 'create':
          data = await sm.createSession({
            title: payload?.title || 'New Session',
            workingDirectory:
              typeof payload?.workingDirectory === 'string' && payload.workingDirectory.trim().length > 0
                ? payload.workingDirectory.trim()
                : undefined,
            modelConfig: resolveSessionDefaultModelConfig(),
          });
          sm.setCurrentSession((data as { id: string }).id);
          break;
        case 'load': {
          const session = await sm.restoreSession(payload?.sessionId as string);
          if (session) {
            const { loadStreamSnapshot } = await import('../host/session/streamSnapshot');
            const streamSnapshot = loadStreamSnapshot({
              workingDir: session.workingDirectory,
              sessionId: session.id,
            });
            if (streamSnapshot?.sessionId === session.id) {
              (session as { streamSnapshot?: unknown }).streamSnapshot = streamSnapshot;
            }
          }
          data = session;
          break;
        }
        case 'delete':
          await sm.deleteSession(payload?.sessionId as string);
          data = null;
          break;
        case 'getMessages':
          data = await sm.getMessages(payload?.sessionId as string);
          break;
        case 'getSessionTasks': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' },
            };
          }
          const { listTasks } = await import('../host/services/planning/taskStore');
          data = listTasks(sessionId);
          break;
        }
        case 'fork': {
          const sourceSessionId = typeof payload?.sourceSessionId === 'string'
            ? payload.sourceSessionId.trim()
            : '';
          const anchorAssistantMessageId = typeof payload?.anchorAssistantMessageId === 'string'
            ? payload.anchorAssistantMessageId.trim()
            : '';
          const idempotencyKey = typeof payload?.idempotencyKey === 'string'
            ? payload.idempotencyKey.trim()
            : '';
          if (!sourceSessionId || !anchorAssistantMessageId || !idempotencyKey) {
            return {
              success: false,
              error: {
                code: 'INVALID_PAYLOAD',
                message: 'sourceSessionId, anchorAssistantMessageId and idempotencyKey are required',
              },
            };
          }
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const { SessionForkService } = await import('../host/services/sessionFork/SessionForkService');
          const service = new SessionForkService(getDatabase(), {
            getRuntimeStatus: (sessionId) => deps.hasActiveRun(sessionId) ? 'running' : undefined,
            ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
          });
          data = await service.createFork({
            sourceSessionId,
            anchorAssistantMessageId,
            idempotencyKey,
            workspaceMode: payload?.workspaceMode === 'isolated_at_anchor'
              ? 'isolated_at_anchor'
              : 'shared_current',
          });
          break;
        }
        case 'getForkLineage': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
          }
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const { SessionForkService } = await import('../host/services/sessionFork/SessionForkService');
          data = new SessionForkService(getDatabase(), {
            ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
          }).getLineage(sessionId);
          break;
        }
        case 'listForkChildren': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return { success: false, error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' } };
          }
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const { SessionForkService } = await import('../host/services/sessionFork/SessionForkService');
          data = new SessionForkService(getDatabase(), {
            ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
          }).listChildren(sessionId);
          break;
        }
        case 'exportSessionFork':
        case 'importSessionFork':
        case 'enqueueSessionForkSync':
        case 'ingestSessionForkSync':
        case 'importReadySessionForkSync':
        case 'searchSessionForkExports':
        case 'readSessionForkTree':
        case 'readSessionForkNeighborhood': {
          const portabilityPayload = (payload ?? {}) as Record<string, unknown>;
          const appService = await createSessionApplicationService(deps);
          if (action === 'exportSessionFork') {
            data = await appService.exportSessionFork(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').ExportSessionForkRequest,
            );
            break;
          }
          if (action === 'importSessionFork') {
            data = await appService.importSessionFork(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').ImportSessionForkRequest,
            );
            break;
          }
          if (action === 'enqueueSessionForkSync') {
            data = await appService.enqueueSessionForkSync(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').EnqueueSessionForkSyncRequest,
            );
          } else if (action === 'ingestSessionForkSync') {
            data = await appService.ingestSessionForkSync(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').IngestSessionForkSyncRequest,
            );
          } else if (action === 'importReadySessionForkSync') {
            data = await appService.importReadySessionForkSync(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').ImportReadySessionForkSyncRequest,
            );
          } else if (action === 'searchSessionForkExports') {
            data = await appService.searchSessionForkExports(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').SearchSessionForkExportsRequest,
            );
          } else if (action === 'readSessionForkTree') {
            data = await appService.readSessionForkTree(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').ReadSessionForkTreeRequest,
            );
          } else {
            data = await appService.readSessionForkNeighborhood(
              portabilityPayload as unknown as import('../shared/contract/sessionForkPortability').ReadSessionForkNeighborhoodRequest,
            );
          }
          break;
        }
        case 'replayConversationBranch':
        case 'compareConversationBranches':
        case 'traceConversationProvenance':
        case 'auditConversationLineage':
        case 'quarantineConversationLineage':
        case 'repairConversationLineage':
        case 'recordConversationEvaluationAttribution':
        case 'listConversationEvaluationAttributions': {
          const branchPayload = (payload ?? {}) as Record<string, unknown>;
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const database = getDatabase();
          const ownerUserId = getAuthService().getCurrentUser()?.id ?? null;
          const requireBoundary = (sessionId: string) => {
            const session = database.getSession(sessionId, { userId: ownerUserId });
            if (!session) {
              throw new Error(`SESSION_ACCESS_DENIED: session ${sessionId} was not found for the current owner`);
            }
            return { ownerUserId, projectId: session.projectId ?? null };
          };
          const sessionId = typeof branchPayload.sessionId === 'string'
            ? branchPayload.sessionId.trim()
            : '';
          if (action === 'compareConversationBranches') {
            const leftSessionId = typeof branchPayload.leftSessionId === 'string'
              ? branchPayload.leftSessionId.trim()
              : '';
            const rightSessionId = typeof branchPayload.rightSessionId === 'string'
              ? branchPayload.rightSessionId.trim()
              : '';
            if (!leftSessionId || !rightSessionId) {
              return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'leftSessionId and rightSessionId are required' },
              };
            }
            const boundary = requireBoundary(leftSessionId);
            const rightBoundary = requireBoundary(rightSessionId);
            if (
              boundary.ownerUserId !== rightBoundary.ownerUserId
              || boundary.projectId !== rightBoundary.projectId
            ) {
              throw new Error('PROJECT_MISMATCH: conversation branches must share one exact owner and project');
            }
            data = database.compareConversationBranches(leftSessionId, rightSessionId, boundary);
            break;
          }
          if (!sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' },
            };
          }
          const boundary = requireBoundary(sessionId);
          if (action === 'replayConversationBranch') {
            data = database.replayConversationBranch(
              sessionId,
              boundary,
              branchPayload.options as {
                includeRewound?: boolean;
                allowRepairOverride?: boolean;
              } | undefined,
            );
          } else if (action === 'traceConversationProvenance') {
            const messageId = typeof branchPayload.messageId === 'string'
              ? branchPayload.messageId.trim()
              : '';
            if (!messageId) {
              return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'messageId is required' },
              };
            }
            data = database.traceConversationProvenance(sessionId, messageId, boundary);
          } else if (action === 'auditConversationLineage') {
            data = database.auditConversationLineage(sessionId, boundary);
          } else if (action === 'quarantineConversationLineage') {
            const idempotencyKey = typeof branchPayload.idempotencyKey === 'string'
              ? branchPayload.idempotencyKey.trim()
              : '';
            if (!idempotencyKey) {
              return {
                success: false,
                error: { code: 'INVALID_PAYLOAD', message: 'idempotencyKey is required' },
              };
            }
            data = database.quarantineConversationLineage(sessionId, boundary, idempotencyKey);
          } else if (action === 'repairConversationLineage') {
            data = database.repairConversationLineage({
              sessionId,
              boundary,
              issueDigest: String(branchPayload.issueDigest ?? ''),
              reason: String(branchPayload.reason ?? ''),
              idempotencyKey: String(branchPayload.idempotencyKey ?? ''),
            });
          } else if (action === 'recordConversationEvaluationAttribution') {
            data = database.recordConversationEvaluationAttribution({
              sessionId,
              boundary,
              evaluationId: String(branchPayload.evaluationId ?? ''),
              runId: typeof branchPayload.runId === 'string' ? branchPayload.runId : null,
              metric: String(branchPayload.metric ?? ''),
              value: Number(branchPayload.value),
              attributedMessageIds: Array.isArray(branchPayload.attributedMessageIds)
                ? branchPayload.attributedMessageIds.filter((value: unknown): value is string => typeof value === 'string')
                : [],
              idempotencyKey: String(branchPayload.idempotencyKey ?? ''),
            });
          } else {
            data = database.listConversationEvaluationAttributions(sessionId, boundary);
          }
          break;
        }
        case 'getRecap': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          if (!sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'sessionId is required' },
            };
          }
          const since = typeof payload?.since === 'number' ? payload.since : 0;
          const { getSessionRecap } = await import('../host/session/sessionRecapService');
          data = await getSessionRecap(sessionId, since);
          break;
        }
        case 'rewindConversation':
        case 'rewindToPrompt': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          const userMessageId = typeof payload?.anchorUserMessageId === 'string'
            ? payload.anchorUserMessageId.trim()
            : typeof payload?.userMessageId === 'string'
              ? payload.userMessageId.trim()
              : '';
          const isLegacyRewind = action === 'rewindToPrompt';
          const suppliedIdempotencyKey = typeof payload?.idempotencyKey === 'string'
            ? payload.idempotencyKey.trim()
            : '';
          if (!sessionId || !userMessageId || (!isLegacyRewind && !suppliedIdempotencyKey)) {
            return {
              success: false,
              error: {
                code: 'INVALID_PAYLOAD',
                message: isLegacyRewind
                  ? 'sessionId and userMessageId are required'
                  : 'sessionId, anchorUserMessageId and idempotencyKey are required',
              },
            };
          }
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const { SessionRewindService } = await import('../host/services/sessionRewind/SessionRewindService');
          data = await new SessionRewindService(getDatabase(), {
            getRuntimeStatus: (id) => deps.hasActiveRun(id) ? 'running' : undefined,
            ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
          }).rewindConversation({
            sessionId,
            anchorUserMessageId: userMessageId,
            idempotencyKey: suppliedIdempotencyKey
              ? suppliedIdempotencyKey
              : `legacy:${sessionId}:${userMessageId}`,
          });
          sm.invalidateSessionCache(sessionId);
          invalidateSessionMessagesProjection(sessionId);
          break;
        }
        case 'restoreConversationRewind': {
          const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
          const rewindId = typeof payload?.rewindId === 'string' ? payload.rewindId.trim() : '';
          if (!sessionId || !rewindId) {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'sessionId and rewindId are required' },
            };
          }
          const { getDatabase } = await import('../host/services/core/databaseService');
          const { getAuthService } = await import('../host/services/auth/authService');
          const { SessionRewindService } = await import('../host/services/sessionRewind/SessionRewindService');
          data = await new SessionRewindService(getDatabase(), {
            getRuntimeStatus: (id) => deps.hasActiveRun(id) ? 'running' : undefined,
            ownerUserId: getAuthService().getCurrentUser()?.id ?? null,
          }).restoreConversation({ sessionId, rewindId });
          sm.invalidateSessionCache(sessionId);
          invalidateSessionMessagesProjection(sessionId);
          break;
        }
        case 'restoreWorkspaceFilesAtCheckpoint': {
          const appService = await createSessionApplicationService(deps);
          data = await appService.restoreWorkspaceFilesAtCheckpoint({
            sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
            checkpointMessageId: typeof payload?.checkpointMessageId === 'string'
              ? payload.checkpointMessageId
              : '',
          });
          break;
        }
        case 'export':
          data = await sm.exportSession(payload?.sessionId as string);
          break;
        case 'update':
          await sm.updateSession(payload?.sessionId as string, payload?.updates || {});
          data = null;
          break;
        case 'archive':
          data = await sm.archiveSession(payload?.sessionId as string);
          break;
        case 'unarchive':
          data = await sm.unarchiveSession(payload?.sessionId as string);
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown session action: ${action}` } };
      }
      return { success: true, data };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'INTERNAL_ERROR';
      return { success: false, error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  });
}
