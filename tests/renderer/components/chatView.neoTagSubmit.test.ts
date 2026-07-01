import { describe, expect, it, vi } from 'vitest';
import type { CreateNeoWorkCardDraftRequest, NeoWorkCardDetail } from '../../../src/shared/contract/tag';
import {
  buildNeoWorkCardDraftRequest,
  submitNeoTagDraft,
} from '../../../src/renderer/components/features/chat/neoTagSubmit';

function makeDetail(input: CreateNeoWorkCardDraftRequest): NeoWorkCardDetail {
  return {
    workCard: {
      id: 'card-1',
      projectId: input.projectId || input.workspacePath || 'current-project',
      sourceConversationId: input.sourceConversationId,
      sourceTurnId: 'turn-1',
      requesterUserId: input.requesterUserId,
      title: input.title,
      status: 'draft',
      currentRevisionId: 'rev-1',
      approvedRevisionId: null,
      createdAt: 100,
      updatedAt: 100,
    },
    currentRevision: {
      id: 'rev-1',
      workCardId: 'card-1',
      revisionNumber: 1,
      ...input.revision,
      readScope: input.revision.readScope as any,
      writeScope: input.revision.writeScope as any,
      modelIntent: input.revision.modelIntent || { mode: 'inherit_current' },
      memoryPlan: input.revision.memoryPlan as any,
      expectedOutputs: input.revision.expectedOutputs || [],
      risks: input.revision.risks || [],
      assumptions: input.revision.assumptions || [],
      createdByUserId: input.requesterUserId,
      createdAt: 100,
    },
    approvedRevision: null,
    revisions: [],
    approvals: [],
    deltas: [],
    resultReviews: [],
    memoryCandidates: [],
  };
}

describe('Neo tag ChatView submit boundary', () => {
  it('builds a draft work card request from a leading @neo envelope', () => {
    const request = buildNeoWorkCardDraftRequest({
      envelope: {
        content: '@neo 实现会话页入口',
        context: {
          routing: { mode: 'direct', targetAgentIds: ['neo-agent'] },
        },
      },
      sourceConversationId: 'session-1',
      workspacePath: '/repo/code-agent',
      projectId: null,
      requesterUserId: 'user-1',
    });

    expect(request).toMatchObject({
      sourceConversationId: 'session-1',
      requesterUserId: 'user-1',
      userText: '实现会话页入口',
      workspacePath: '/repo/code-agent',
      revision: {
        taskSummary: '实现会话页入口',
        writeScope: {
          mode: 'none',
          canCreateFiles: false,
          canModifyFiles: false,
        },
        modelIntent: { mode: 'inherit_current' },
      },
    });
    expect(request?.revision.readScope?.projectId).toBe('/repo/code-agent');
  });

  it('does not call tag IPC for ordinary chat envelopes', async () => {
    const createDraft = vi.fn();

    const result = await submitNeoTagDraft({
      envelope: { content: '普通消息' },
      sourceConversationId: 'session-1',
      requesterUserId: 'user-1',
      createDraft,
    });

    expect(result).toBeNull();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('rejects an empty @neo draft before calling the tag boundary', () => {
    expect(() => buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo   ' },
      sourceConversationId: 'session-1',
      requesterUserId: 'user-1',
    })).toThrow('写一下 Neo 要做什么。');
  });

  it('submits leading @neo through the renderer tag service boundary', async () => {
    const createDraft = vi.fn(async (input: CreateNeoWorkCardDraftRequest) => ({
      detail: makeDetail(input),
      sourceTurnId: 'turn-1',
    }));

    const result = await submitNeoTagDraft({
      envelope: { content: '@neo 做一个 draft card' },
      sourceConversationId: 'session-1',
      projectId: 'project-1',
      requesterUserId: 'user-1',
      createDraft,
    });

    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(createDraft.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project-1',
      userText: '做一个 draft card',
      revision: {
        taskSummary: '做一个 draft card',
      },
    });
    expect(result?.detail.workCard.id).toBe('card-1');
  });
});
