import type { IpcMain } from '../platform';
import { IPC_CHANNELS, type IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { TagSchemas, type TagDomainRequest } from '../../shared/ipc/schemas/tag';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { randomUUID } from 'crypto';
import type {
  AppendNeoWorkCardDeltaInput,
  CloseNeoWorkCardInput,
  ContinueNeoWorkCardRequest,
  CreateNeoWorkCardDraftInput,
  ListNeoWorkCardsBySourceInput,
  NeoMemoryCandidateDecisionInput,
  NeoWorkCardAcceptResultInput,
  NeoTagEvent,
  NeoWorkCardUpdateReason,
  NeoWorkCardListOptions,
  NeoWorkCardRequestChangesInput,
  ReviewNeoWorkCardRevisionInput,
  UpdateNeoWorkCardDraftRevisionInput,
  UpdateNeoWorkCardMetaInput,
} from '../../shared/contract/tag';
import { AppWindow } from '../platform';
import {
  getNeoWorkCardService,
  NeoWorkCardServiceError,
} from '../services/project/neoWorkCardService';
import {
  continueAndRunNeoWorkCard,
  createAndRunNeoWorkCard,
  launchApprovedNeoWorkCard,
} from '../services/project/neoTagRuntimeService';
import { getTaskManager } from '../task';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('TagIPC');

interface GetPayload {
  workCardId?: string;
}

interface ListPayload extends NeoWorkCardListOptions {
  projectId?: string;
}

interface ListBySourcePayload extends ListNeoWorkCardsBySourceInput, NeoWorkCardListOptions {}

interface ReviewPayload {
  workCardId?: string;
  revisionId?: string;
  reviewerUserId?: string;
  approvedByUserId?: string;
  rejectedByUserId?: string;
  feedback?: string | null;
  expiresAt?: number | null;
}

interface CancelPayload {
  workCardId?: string;
  actorUserId?: string;
  cancelledByUserId?: string;
  feedback?: string | null;
}

interface ResultReviewPayload {
  workCardId?: string;
  actorUserId?: string;
  feedback?: string | null;
  openQuestions?: string[];
}

interface MemoryCandidateDecisionPayload {
  candidateId?: string;
  actorUserId?: string;
  reason?: string | null;
}

function invalid(message: string): IPCResponse {
  return { success: false, error: { code: 'INVALID_ARGS', message } };
}

function notFound(message: string): IPCResponse {
  return { success: false, error: { code: 'NOT_FOUND', message } };
}

function mapTagError(error: unknown): { code: string; message: string } {
  if (error instanceof NeoWorkCardServiceError) {
    return { code: error.code, message: error.message };
  }
  logger.error('Tag IPC error', error);
  return { code: 'TAG_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
}

function deliverToRenderers(channel: string, payload: unknown): void {
  for (const win of AppWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function emitWorkCardUpdated(
  service: ReturnType<typeof getNeoWorkCardService>,
  workCardId: string,
  reason: NeoWorkCardUpdateReason,
): void {
  const detail = service.get(workCardId);
  if (!detail) return;
  const event: NeoTagEvent = {
    type: 'work_card_updated',
    reason,
    workCardId: detail.workCard.id,
    projectId: detail.workCard.projectId,
    sourceConversationId: detail.workCard.sourceConversationId,
    status: detail.workCard.status,
    detail,
    occurredAt: Date.now(),
  };
  deliverToRenderers(IPC_CHANNELS.TAG_EVENT, event);
}

/**
 * tag 域单源路由表（RQ-183 续作·TAG 刀）：原 domain switch 逐 case 平移为 handler（rawResponse：
 * handler 仍返回完整 IPCResponse，含 INVALID_ARGS / NOT_FOUND 失败响应，逐字不变）；每个 handler
 * 按请求取 getNeoWorkCardService()（同原 switch 每请求取一次）；未知 action → UNKNOWN_ACTION
 * `Unknown tag action: <action>`；抛错 → mapTagError（服务层 code 透传 / TAG_ERROR + 日志）。
 */
const tagHandlers: RawDomainRouteHandlers<TagDomainRequest, void> = {
  createDraft: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const input = payload as CreateNeoWorkCardDraftInput | undefined;
    if (!input) return invalid('payload is required');
    const created = service.createDraft(input);
    emitWorkCardUpdated(service, created.workCard.id, 'draft_created');
    return { success: true, data: created };
  },
  createAndRun: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    // @neo 直接开干（轻量化重设计）：建卡 → 自动批准 → 落地运行，无审批门。
    const input = payload as CreateNeoWorkCardDraftInput | undefined;
    if (!input) return invalid('payload is required');
    const started = createAndRunNeoWorkCard({
      draft: input,
      taskManager: getTaskManager(),
      service,
      onWorkCardUpdated: (workCardId, reason) => emitWorkCardUpdated(service, workCardId, reason),
    });
    started.run.catch((error) => {
      logger.error('Failed to run direct @neo work card', error);
    });
    return { success: true, data: { workCard: started.workCard, revision: started.revision } };
  },
  continueAndRun: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    // @neo 跨会话续接（ADR-035）：既有 topic 追加一轮，落点 = 发起续接的会话。
    const input = payload as ContinueNeoWorkCardRequest | undefined;
    if (!input?.workCardId || !input.conversationId || !input.requesterUserId) {
      return invalid('workCardId, conversationId and requesterUserId are required');
    }
    const roundTurnId = input.clientSourceMessageId?.trim()
      || `neo-source-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const started = continueAndRunNeoWorkCard({
      workCardId: input.workCardId,
      conversationId: input.conversationId,
      turnId: roundTurnId,
      userText: input.userText ?? '',
      requesterUserId: input.requesterUserId,
      selectedArtifactIds: input.selectedArtifactIds,
      taskManager: getTaskManager(),
      service,
      onWorkCardUpdated: (workCardId, reason) => emitWorkCardUpdated(service, workCardId, reason),
    });
    started.run.catch((error) => {
      logger.error('Failed to run @neo follow-up round', error);
    });
    return {
      success: true,
      data: { workCard: started.workCard, revision: started.revision, roundTurnId },
    };
  },
  get: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const { workCardId } = (payload ?? {}) as GetPayload;
    if (!workCardId) return invalid('workCardId is required');
    const detail = service.get(workCardId);
    return detail ? { success: true, data: detail } : notFound('work card not found');
  },
  read: (ctx, payload) => tagHandlers.get(ctx, payload),
  list: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const { projectId, includeArchived, statuses, limit } = (payload ?? {}) as ListPayload;
    if (!projectId) return invalid('projectId is required');
    return { success: true, data: service.listByProject(projectId, { includeArchived, statuses, limit }) };
  },
  listByProject: (ctx, payload) => tagHandlers.list(ctx, payload),
  // 全局 topic 目录：跨项目列全部工作卡（账号菜单「Neo 协同」在无绑定项目时用）
  listAll: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const { includeArchived, statuses, limit } = (payload ?? {}) as NeoWorkCardListOptions;
    return { success: true, data: service.listAll({ includeArchived, statuses, limit }) };
  },
  listBySourceConversation: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const { sourceConversationId, includeArchived, statuses, limit } = (payload ?? {}) as ListBySourcePayload;
    if (!sourceConversationId) return invalid('sourceConversationId is required');
    return {
      success: true,
      data: service.listBySourceConversation(sourceConversationId, { includeArchived, statuses, limit }),
    };
  },
  updateRevision: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const input = payload as UpdateNeoWorkCardDraftRevisionInput | undefined;
    if (!input) return invalid('payload is required');
    const updated = service.updateDraftRevision(input);
    emitWorkCardUpdated(service, updated.workCard.id, 'draft_updated');
    return { success: true, data: updated };
  },
  updateDraftRevision: (ctx, payload) => tagHandlers.updateRevision(ctx, payload),
  updateMeta: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const input = payload as UpdateNeoWorkCardMetaInput | undefined;
    if (!input?.workCardId || !input.actorUserId) {
      return invalid('workCardId and actorUserId are required');
    }
    const updated = service.updateMeta(input);
    emitWorkCardUpdated(service, updated.id, 'meta_updated');
    return { success: true, data: updated };
  },
  approve: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const review = (payload ?? {}) as ReviewPayload;
    const reviewerUserId = review.reviewerUserId ?? review.approvedByUserId;
    if (!review.workCardId || !reviewerUserId) {
      return invalid('workCardId and reviewerUserId are required');
    }
    const input: ReviewNeoWorkCardRevisionInput = {
      workCardId: review.workCardId,
      revisionId: review.revisionId,
      reviewerUserId,
      feedback: review.feedback,
      expiresAt: review.expiresAt,
    };
    const approval = service.approveRevision(input);
    emitWorkCardUpdated(service, input.workCardId, 'revision_approved');
    launchApprovedNeoWorkCard({
      workCardId: input.workCardId,
      taskManager: getTaskManager(),
      service,
      onWorkCardUpdated: (workCardId, reason) => emitWorkCardUpdated(service, workCardId, reason),
    }).catch((error) => {
      logger.error('Failed to launch approved Neo work card runtime', error);
    });
    return { success: true, data: approval };
  },
  approveRevision: (ctx, payload) => tagHandlers.approve(ctx, payload),
  reject: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const review = (payload ?? {}) as ReviewPayload;
    const reviewerUserId = review.reviewerUserId ?? review.rejectedByUserId;
    if (!review.workCardId || !reviewerUserId) {
      return invalid('workCardId and reviewerUserId are required');
    }
    const input: ReviewNeoWorkCardRevisionInput = {
      workCardId: review.workCardId,
      revisionId: review.revisionId,
      reviewerUserId,
      feedback: review.feedback,
    };
    const rejection = service.rejectRevision(input);
    emitWorkCardUpdated(service, input.workCardId, 'revision_rejected');
    return { success: true, data: rejection };
  },
  rejectRevision: (ctx, payload) => tagHandlers.reject(ctx, payload),
  cancel: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const cancel = (payload ?? {}) as CancelPayload;
    const actorUserId = cancel.actorUserId ?? cancel.cancelledByUserId;
    if (!cancel.workCardId || !actorUserId) {
      return invalid('workCardId and actorUserId are required');
    }
    const input: CloseNeoWorkCardInput = {
      workCardId: cancel.workCardId,
      actorUserId,
      feedback: cancel.feedback,
    };
    const cancelled = service.cancel(input);
    if (cancelled) emitWorkCardUpdated(service, cancelled.id, 'card_cancelled');
    return cancelled ? { success: true, data: cancelled } : notFound('work card not found');
  },
  archive: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const archive = (payload ?? {}) as CancelPayload;
    if (!archive.workCardId) return invalid('workCardId is required');
    const archived = archive.actorUserId
      ? service.archive({
        workCardId: archive.workCardId,
        actorUserId: archive.actorUserId,
        feedback: archive.feedback,
      })
      : service.archive(archive.workCardId);
    if (archived) emitWorkCardUpdated(service, archived.id, 'card_archived');
    return archived ? { success: true, data: archived } : notFound('work card not found');
  },
  acceptResult: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const review = (payload ?? {}) as ResultReviewPayload;
    if (!review.workCardId || !review.actorUserId) {
      return invalid('workCardId and actorUserId are required');
    }
    const input: NeoWorkCardAcceptResultInput = {
      workCardId: review.workCardId,
      actorUserId: review.actorUserId,
      feedback: review.feedback,
    };
    const accepted = service.acceptResult(input);
    emitWorkCardUpdated(service, input.workCardId, 'result_accepted');
    return { success: true, data: accepted };
  },
  requestChanges: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const review = (payload ?? {}) as ResultReviewPayload;
    if (!review.workCardId || !review.actorUserId) {
      return invalid('workCardId and actorUserId are required');
    }
    const input: NeoWorkCardRequestChangesInput = {
      workCardId: review.workCardId,
      actorUserId: review.actorUserId,
      feedback: review.feedback,
      openQuestions: review.openQuestions,
    };
    const changed = service.requestChanges(input);
    emitWorkCardUpdated(service, input.workCardId, 'changes_requested');
    return { success: true, data: changed };
  },
  approveMemoryCandidate: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const decision = (payload ?? {}) as MemoryCandidateDecisionPayload;
    if (!decision.candidateId || !decision.actorUserId) {
      return invalid('candidateId and actorUserId are required');
    }
    const input: NeoMemoryCandidateDecisionInput = {
      candidateId: decision.candidateId,
      actorUserId: decision.actorUserId,
    };
    const candidate = service.approveMemoryCandidate(input);
    emitWorkCardUpdated(service, candidate.workCardId, 'memory_candidate_updated');
    return { success: true, data: candidate };
  },
  rejectMemoryCandidate: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const decision = (payload ?? {}) as MemoryCandidateDecisionPayload;
    if (!decision.candidateId || !decision.actorUserId) {
      return invalid('candidateId and actorUserId are required');
    }
    const input: NeoMemoryCandidateDecisionInput = {
      candidateId: decision.candidateId,
      actorUserId: decision.actorUserId,
      reason: decision.reason,
    };
    const candidate = service.rejectMemoryCandidate(input);
    emitWorkCardUpdated(service, candidate.workCardId, 'memory_candidate_updated');
    return { success: true, data: candidate };
  },
  appendDelta: async (_ctx, payload) => {
    const service = getNeoWorkCardService();
    const input = payload as AppendNeoWorkCardDeltaInput | undefined;
    if (!input?.workCardId || !input.runId) {
      return invalid('workCardId and runId are required');
    }
    const delta = service.appendDelta(input);
    emitWorkCardUpdated(service, input.workCardId, 'delta_appended');
    return { success: true, data: delta };
  },
};

const tagRoutes = defineDomainRoutes<TagDomainRequest, void>(TagSchemas.REQUEST, tagHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown tag action: ${String(action)}`,
  mapError: (error) => mapTagError(error),
});

export function registerTagHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, tagRoutes, undefined);

  logger.info('Tag IPC handlers registered');
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerTagHandlers.routes = tagRoutes;
