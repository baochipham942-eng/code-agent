import type {
  ContinueNeoWorkCardRequest,
  ContinueNeoWorkCardResult,
  CreateNeoWorkCardDraftInput,
  CreateNeoWorkCardDraftRequest,
  CreateNeoWorkCardDraftResult,
  ListAllNeoWorkCardsInput,
  ListNeoWorkCardsByProjectInput,
  ListNeoWorkCardsBySourceInput,
  NeoMemoryCandidate,
  NeoMemoryCandidateDecisionInput,
  NeoTagEvent,
  NeoWorkCardCloseActionInput,
  NeoWorkCardAcceptResultInput,
  NeoWorkCardDetail,
  NeoWorkCardRequestChangesInput,
  NeoWorkCardReviewActionInput,
  UpdateNeoWorkCardDraftRevisionRequest,
  NeoWorkCardWithCurrentRevision,
} from '@shared/contract/tag';
import { NEO_TAG_IPC_DOMAIN } from '@shared/contract/tag';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from './ipcService';

export class NeoTagIpcUnavailableError extends Error {
  constructor(message = 'Neo Tag IPC is not available') {
    super(message);
    this.name = 'NeoTagIpcUnavailableError';
  }
}

export function isNeoTagIpcUnavailableError(error: unknown): boolean {
  return error instanceof NeoTagIpcUnavailableError
    || (error instanceof Error && /domain:tag|Neo Tag IPC|not available/i.test(error.message));
}

function assertDomainApiAvailable(): void {
  const api = window.codeAgentDomainAPI || window.domainAPI;
  if (!api) {
    throw new NeoTagIpcUnavailableError();
  }
}

async function invokeTag<T>(action: string, payload?: unknown): Promise<T> {
  assertDomainApiAvailable();
  return ipcService.invokeDomain<T>(NEO_TAG_IPC_DOMAIN, action, payload);
}

function createSourceTurnId(input: CreateNeoWorkCardDraftRequest): string {
  if (input.clientSourceMessageId?.trim()) return input.clientSourceMessageId.trim();
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `neo-source-${randomId}`;
}

function toDetail(result: NeoWorkCardWithCurrentRevision): NeoWorkCardDetail {
  return {
    workCard: result.workCard,
    currentRevision: result.revision,
    approvedRevision: result.workCard.approvedRevisionId === result.revision.id ? result.revision : null,
    revisions: [result.revision],
    approvals: [],
    deltas: [],
    resultReviews: [],
    memoryCandidates: [],
  };
}

function toCreateDraftInput(input: CreateNeoWorkCardDraftRequest): CreateNeoWorkCardDraftInput {
  const projectId = input.projectId?.trim();
  if (!projectId) {
    throw new Error('当前会话还没有绑定项目，先在项目会话里使用 @neo。');
  }
  return {
    projectId,
    sourceConversationId: input.sourceConversationId,
    sourceTurnId: createSourceTurnId(input),
    requesterUserId: input.requesterUserId,
    title: input.title,
    userText: input.userText,
    selectedMessageIds: input.selectedMessageIds,
    selectedArtifactIds: input.selectedArtifactIds,
    revision: {
      ...input.revision,
      readScope: {
        ...input.revision.readScope,
        projectId,
      },
      writeScope: {
        ...input.revision.writeScope,
        projectId,
      },
    },
  };
}

async function readDetail(workCardId: string): Promise<NeoWorkCardDetail> {
  return invokeTag<NeoWorkCardDetail>('get', { workCardId });
}

export const tagClient = {
  async createDraft(input: CreateNeoWorkCardDraftRequest): Promise<CreateNeoWorkCardDraftResult> {
    const backendInput = toCreateDraftInput(input);
    const created = await invokeTag<NeoWorkCardWithCurrentRevision>('createDraft', backendInput);
    return {
      detail: toDetail(created),
      sourceTurnId: created.workCard.sourceTurnId,
    };
  },

  // @neo 直接开干：建卡即运行（无审批门），后台落地运行，立即返回已建卡。
  async createAndRun(input: CreateNeoWorkCardDraftRequest): Promise<CreateNeoWorkCardDraftResult> {
    const backendInput = toCreateDraftInput(input);
    const created = await invokeTag<NeoWorkCardWithCurrentRevision>('createAndRun', backendInput);
    return {
      detail: toDetail(created),
      sourceTurnId: created.workCard.sourceTurnId,
    };
  },

  // @neo 跨会话续接：既有 topic 追加一轮，落点 = 当前会话（ADR-033）。
  async continueAndRun(input: ContinueNeoWorkCardRequest): Promise<ContinueNeoWorkCardResult> {
    const result = await invokeTag<{
      workCard: NeoWorkCardWithCurrentRevision['workCard'];
      revision: NeoWorkCardWithCurrentRevision['revision'];
      roundTurnId: string;
    }>('continueAndRun', input);
    return {
      detail: toDetail({ workCard: result.workCard, revision: result.revision }),
      roundTurnId: result.roundTurnId,
    };
  },

  listBySourceConversation(input: ListNeoWorkCardsBySourceInput): Promise<NeoWorkCardDetail[]> {
    return invokeTag<NeoWorkCardDetail[]>('listBySourceConversation', input);
  },

  async listByProject(input: ListNeoWorkCardsByProjectInput): Promise<NeoWorkCardDetail[]> {
    const cards = await invokeTag<NeoWorkCardWithCurrentRevision['workCard'][]>('listByProject', input);
    const details = await Promise.all(cards.map((card) => readDetail(card.id)));
    return details;
  },

  // 全局 topic 目录：跨项目列全部工作卡（无绑定项目的入口也能看历史）
  async listAll(input: ListAllNeoWorkCardsInput = {}): Promise<NeoWorkCardDetail[]> {
    const cards = await invokeTag<NeoWorkCardWithCurrentRevision['workCard'][]>('listAll', input);
    const details = await Promise.all(cards.map((card) => readDetail(card.id)));
    return details;
  },

  async updateDraftRevision(input: UpdateNeoWorkCardDraftRevisionRequest): Promise<NeoWorkCardDetail> {
    const updated = await invokeTag<NeoWorkCardWithCurrentRevision>('updateDraftRevision', input);
    return readDetail(updated.workCard.id);
  },

  async approve(input: NeoWorkCardReviewActionInput): Promise<NeoWorkCardDetail> {
    await invokeTag('approveRevision', {
      workCardId: input.workCardId,
      revisionId: input.revisionId,
      reviewerUserId: input.actorUserId,
      feedback: input.feedback,
      expiresAt: input.expiresAt,
    });
    return readDetail(input.workCardId);
  },

  async reject(input: NeoWorkCardReviewActionInput): Promise<NeoWorkCardDetail> {
    await invokeTag('rejectRevision', {
      workCardId: input.workCardId,
      revisionId: input.revisionId,
      reviewerUserId: input.actorUserId,
      feedback: input.feedback,
    });
    return readDetail(input.workCardId);
  },

  async cancel(input: NeoWorkCardCloseActionInput): Promise<NeoWorkCardDetail> {
    await invokeTag('cancel', input);
    return readDetail(input.workCardId);
  },

  async archive(input: NeoWorkCardCloseActionInput): Promise<NeoWorkCardDetail> {
    await invokeTag('archive', input);
    return readDetail(input.workCardId);
  },

  acceptResult(input: NeoWorkCardAcceptResultInput): Promise<NeoWorkCardDetail> {
    return invokeTag<NeoWorkCardDetail>('acceptResult', input);
  },

  requestChanges(input: NeoWorkCardRequestChangesInput): Promise<NeoWorkCardDetail> {
    return invokeTag<NeoWorkCardDetail>('requestChanges', input);
  },

  approveMemoryCandidate(input: NeoMemoryCandidateDecisionInput): Promise<NeoMemoryCandidate> {
    return invokeTag<NeoMemoryCandidate>('approveMemoryCandidate', input);
  },

  rejectMemoryCandidate(input: NeoMemoryCandidateDecisionInput): Promise<NeoMemoryCandidate> {
    return invokeTag<NeoMemoryCandidate>('rejectMemoryCandidate', input);
  },

  onWorkCardEvent(callback: (event: NeoTagEvent) => void): (() => void) | undefined {
    return ipcService.on(IPC_CHANNELS.TAG_EVENT, callback);
  },
};
