import { create } from 'zustand';
import type {
  CreateNeoWorkCardDraftRequest,
  CreateNeoWorkCardDraftResult,
  NeoMemoryCandidate,
  NeoMemoryCandidateDecisionInput,
  NeoWorkCardCloseActionInput,
  NeoWorkCardAcceptResultInput,
  NeoWorkCardDetail,
  NeoWorkCardRequestChangesInput,
  NeoWorkCardReviewActionInput,
  UpdateNeoWorkCardDraftRevisionRequest,
  NeoWorkCardStatus,
} from '@shared/contract/tag';
import { isNeoTagIpcUnavailableError, tagClient } from '../services/tagClient';
import {
  getProjectCollaborationBadge,
  type ProjectCollaborationWorkCardRecord,
} from '../components/features/projectCollaboration/projectCollaborationData';

interface NeoWorkCardState {
  detailsById: Record<string, NeoWorkCardDetail>;
  loadingConversationIds: Record<string, boolean>;
  loadingProjectIds: Record<string, boolean>;
  pendingStatusById: Record<string, boolean>;
  lastErrorByProjectId: Record<string, string | null>;
  loadForConversation: (sourceConversationId: string) => Promise<void>;
  loadForProject: (projectId: string, options?: { includeArchived?: boolean }) => Promise<void>;
  /** 全局 topic 目录：跨项目加载全部工作卡。loading/error 状态挂在 NEO_WORK_CARD_ALL_SCOPE 键下。 */
  loadAll: (options?: { includeArchived?: boolean }) => Promise<void>;
  createDraft: (input: CreateNeoWorkCardDraftRequest) => Promise<CreateNeoWorkCardDraftResult>;
  createAndRun: (input: CreateNeoWorkCardDraftRequest) => Promise<CreateNeoWorkCardDraftResult>;
  updateDraftRevision: (input: UpdateNeoWorkCardDraftRevisionRequest) => Promise<NeoWorkCardDetail>;
  approve: (input: NeoWorkCardReviewActionInput) => Promise<NeoWorkCardDetail>;
  reject: (input: NeoWorkCardReviewActionInput) => Promise<NeoWorkCardDetail>;
  cancel: (input: NeoWorkCardCloseActionInput) => Promise<NeoWorkCardDetail>;
  archive: (input: NeoWorkCardCloseActionInput) => Promise<NeoWorkCardDetail>;
  acceptResult: (input: NeoWorkCardAcceptResultInput) => Promise<NeoWorkCardDetail>;
  requestChanges: (input: NeoWorkCardRequestChangesInput) => Promise<NeoWorkCardDetail>;
  approveMemoryCandidate: (input: NeoMemoryCandidateDecisionInput) => Promise<NeoMemoryCandidate>;
  rejectMemoryCandidate: (input: NeoMemoryCandidateDecisionInput) => Promise<NeoMemoryCandidate>;
  upsertDetail: (detail: NeoWorkCardDetail) => void;
}

export const NEO_WORK_CARD_LIVE_REFRESH_MS = 1500;

/** 全局目录 scope 键：loadAll 的 loading/error 状态挂在这个键下（与真实 projectId 不冲突）。 */
export const NEO_WORK_CARD_ALL_SCOPE = '*';

const RUNTIME_AWAITING_TERMINAL_STATUSES = new Set<NeoWorkCardStatus>([
  'approved',
  'queued',
  'working',
  'waiting_for_user',
]);

export function isNeoWorkCardAwaitingRuntimeTerminal(status: NeoWorkCardStatus): boolean {
  return RUNTIME_AWAITING_TERMINAL_STATUSES.has(status);
}

function upsert(
  detailsById: Record<string, NeoWorkCardDetail>,
  detail: NeoWorkCardDetail,
): Record<string, NeoWorkCardDetail> {
  return {
    ...detailsById,
    [detail.workCard.id]: detail,
  };
}

function replaceCandidate(
  detailsById: Record<string, NeoWorkCardDetail>,
  candidate: NeoMemoryCandidate,
): Record<string, NeoWorkCardDetail> {
  const detail = detailsById[candidate.workCardId];
  if (!detail) return detailsById;
  return {
    ...detailsById,
    [candidate.workCardId]: {
      ...detail,
      memoryCandidates: detail.memoryCandidates.map((item) => item.id === candidate.id ? candidate : item),
    },
  };
}

export const useNeoWorkCardStore = create<NeoWorkCardState>()((set) => {
  const withPending = async (
    workCardId: string,
    action: () => Promise<NeoWorkCardDetail>,
  ): Promise<NeoWorkCardDetail> => {
    set((state) => ({
      pendingStatusById: {
        ...state.pendingStatusById,
        [workCardId]: true,
      },
    }));
    try {
      const detail = await action();
      set((state) => ({
        detailsById: upsert(state.detailsById, detail),
        pendingStatusById: {
          ...state.pendingStatusById,
          [workCardId]: false,
        },
      }));
      return detail;
    } catch (error) {
      set((state) => ({
        pendingStatusById: {
          ...state.pendingStatusById,
          [workCardId]: false,
        },
      }));
      throw error;
    }
  };

  return {
    detailsById: {},
    loadingConversationIds: {},
    loadingProjectIds: {},
    pendingStatusById: {},
    lastErrorByProjectId: {},

    loadForConversation: async (sourceConversationId) => {
      set((state) => ({
        loadingConversationIds: {
          ...state.loadingConversationIds,
          [sourceConversationId]: true,
        },
      }));
      try {
        const details = await tagClient.listBySourceConversation({ sourceConversationId });
        set((state) => ({
          detailsById: details.reduce(upsert, state.detailsById),
          loadingConversationIds: {
            ...state.loadingConversationIds,
            [sourceConversationId]: false,
          },
        }));
      } catch (error) {
        set((state) => ({
          loadingConversationIds: {
            ...state.loadingConversationIds,
            [sourceConversationId]: false,
          },
        }));
        if (!isNeoTagIpcUnavailableError(error)) {
          throw error;
        }
      }
    },

    loadForProject: async (projectId, options = {}) => {
      const normalizedProjectId = projectId.trim();
      if (!normalizedProjectId) return;
      set((state) => ({
        loadingProjectIds: {
          ...state.loadingProjectIds,
          [normalizedProjectId]: true,
        },
        lastErrorByProjectId: {
          ...state.lastErrorByProjectId,
          [normalizedProjectId]: null,
        },
      }));
      try {
        const details = await tagClient.listByProject({
          projectId: normalizedProjectId,
          includeArchived: options.includeArchived,
        });
        set((state) => ({
          detailsById: details.reduce(upsert, state.detailsById),
          loadingProjectIds: {
            ...state.loadingProjectIds,
            [normalizedProjectId]: false,
          },
          lastErrorByProjectId: {
            ...state.lastErrorByProjectId,
            [normalizedProjectId]: null,
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : '加载 Neo work cards 失败';
        set((state) => ({
          loadingProjectIds: {
            ...state.loadingProjectIds,
            [normalizedProjectId]: false,
          },
          lastErrorByProjectId: {
            ...state.lastErrorByProjectId,
            [normalizedProjectId]: message,
          },
        }));
        if (!isNeoTagIpcUnavailableError(error)) {
          throw error;
        }
      }
    },

    loadAll: async (options = {}) => {
      const scope = NEO_WORK_CARD_ALL_SCOPE;
      set((state) => ({
        loadingProjectIds: { ...state.loadingProjectIds, [scope]: true },
        lastErrorByProjectId: { ...state.lastErrorByProjectId, [scope]: null },
      }));
      try {
        const details = await tagClient.listAll({ includeArchived: options.includeArchived });
        set((state) => ({
          detailsById: details.reduce(upsert, state.detailsById),
          loadingProjectIds: { ...state.loadingProjectIds, [scope]: false },
          lastErrorByProjectId: { ...state.lastErrorByProjectId, [scope]: null },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : '加载 Neo work cards 失败';
        set((state) => ({
          loadingProjectIds: { ...state.loadingProjectIds, [scope]: false },
          lastErrorByProjectId: { ...state.lastErrorByProjectId, [scope]: message },
        }));
        if (!isNeoTagIpcUnavailableError(error)) {
          throw error;
        }
      }
    },

    createDraft: async (input) => {
      const result = await tagClient.createDraft(input);
      set((state) => ({
        detailsById: upsert(state.detailsById, result.detail),
      }));
      return result;
    },

    createAndRun: async (input) => {
      const result = await tagClient.createAndRun(input);
      set((state) => ({
        detailsById: upsert(state.detailsById, result.detail),
      }));
      return result;
    },

    updateDraftRevision: async (input) => withPending(input.workCardId, () => tagClient.updateDraftRevision(input)),

    approve: async (input) => withPending(input.workCardId, () => tagClient.approve(input)),

    reject: async (input) => withPending(input.workCardId, () => tagClient.reject(input)),

    cancel: async (input) => withPending(input.workCardId, () => tagClient.cancel(input)),

    archive: async (input) => withPending(input.workCardId, () => tagClient.archive(input)),

    acceptResult: async (input) => withPending(input.workCardId, () => tagClient.acceptResult(input)),

    requestChanges: async (input) => withPending(input.workCardId, () => tagClient.requestChanges(input)),

    approveMemoryCandidate: async (input) => {
      const candidate = await tagClient.approveMemoryCandidate(input);
      set((state) => ({
        detailsById: replaceCandidate(state.detailsById, candidate),
      }));
      return candidate;
    },

    rejectMemoryCandidate: async (input) => {
      const candidate = await tagClient.rejectMemoryCandidate(input);
      set((state) => ({
        detailsById: replaceCandidate(state.detailsById, candidate),
      }));
      return candidate;
    },

    upsertDetail: (detail) => {
      set((state) => ({
        detailsById: upsert(state.detailsById, detail),
      }));
    },
  };
});

let neoWorkCardLiveUpdatesUnsubscribe: (() => void) | undefined;

export function ensureNeoWorkCardLiveUpdates(): void {
  if (neoWorkCardLiveUpdatesUnsubscribe) return;
  neoWorkCardLiveUpdatesUnsubscribe = tagClient.onWorkCardEvent((event) => {
    if (event.type !== 'work_card_updated') return;
    useNeoWorkCardStore.getState().upsertDetail(event.detail);
  });
}

export function resetNeoWorkCardLiveUpdatesForTests(): void {
  neoWorkCardLiveUpdatesUnsubscribe?.();
  neoWorkCardLiveUpdatesUnsubscribe = undefined;
}

export function selectNeoWorkCardDetailsForConversation(
  state: Pick<NeoWorkCardState, 'detailsById'>,
  sourceConversationId: string | null,
): NeoWorkCardDetail[] {
  if (!sourceConversationId) return [];
  return Object.values(state.detailsById)
    .filter((detail) => detail.workCard.sourceConversationId === sourceConversationId)
    .sort((a, b) => a.workCard.createdAt - b.workCard.createdAt);
}

/** 全局 topic 目录：全部工作卡，最近活动在前。 */
export function selectAllNeoWorkCardDetails(
  state: Pick<NeoWorkCardState, 'detailsById'>,
): NeoWorkCardDetail[] {
  return Object.values(state.detailsById)
    .sort((a, b) => b.workCard.updatedAt - a.workCard.updatedAt);
}

export function selectNeoWorkCardDetailsForProject(
  state: Pick<NeoWorkCardState, 'detailsById'>,
  projectId: string | null,
): NeoWorkCardDetail[] {
  if (!projectId) return [];
  return Object.values(state.detailsById)
    .filter((detail) => detail.workCard.projectId === projectId)
    .sort((a, b) => b.workCard.updatedAt - a.workCard.updatedAt);
}

export function selectNeoWorkCardBadgeForProject(
  state: Pick<NeoWorkCardState, 'detailsById'>,
  projectId: string | null,
) {
  const records = selectNeoWorkCardDetailsForProject(state, projectId).flatMap((detail): ProjectCollaborationWorkCardRecord[] => {
    const revision = detail.currentRevision ?? detail.approvedRevision;
    if (!revision) return [];
    return [{
      card: detail.workCard,
      revision,
      delta: detail.deltas.at(-1),
      memoryCandidates: detail.memoryCandidates,
    }];
  });
  return getProjectCollaborationBadge(records);
}
