import { describe, expect, it, vi } from 'vitest';
import type { ContinueNeoWorkCardRequest, CreateNeoWorkCardDraftRequest, NeoWorkCardDetail } from '../../../src/shared/contract/tag';
import {
  buildNeoTagContinuationMessage,
  buildNeoTagSourceMessage,
  buildNeoWorkCardDraftRequest,
  submitNeoTagContinuation,
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

  it('falls back to the session working dir as projectId when none is bound (无需先绑项目)', () => {
    const withWorkspace = buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo 写段产品方案' },
      sourceConversationId: 'session-1',
      workspacePath: '/repo/code-agent',
      projectId: null,
      requesterUserId: 'user-1',
    });
    expect(withWorkspace?.projectId).toBe('/repo/code-agent');

    const noWorkspace = buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo 写段产品方案' },
      sourceConversationId: 'session-1',
      projectId: null,
      requesterUserId: 'user-1',
    });
    expect(noWorkspace?.projectId).toBe('current-project');

    const explicit = buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo 写段产品方案' },
      sourceConversationId: 'session-1',
      workspacePath: '/repo/code-agent',
      projectId: 'proj-real',
      requesterUserId: 'user-1',
    });
    expect(explicit?.projectId).toBe('proj-real');
  });

  it('does not call tag IPC for ordinary chat envelopes', async () => {
    const runNeoTag = vi.fn();

    const result = await submitNeoTagDraft({
      envelope: { content: '普通消息' },
      sourceConversationId: 'session-1',
      requesterUserId: 'user-1',
      runNeoTag,
    });

    expect(result).toBeNull();
    expect(runNeoTag).not.toHaveBeenCalled();
  });

  it('rejects an empty @neo draft before calling the tag boundary', () => {
    expect(() => buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo   ' },
      sourceConversationId: 'session-1',
      requesterUserId: 'user-1',
    })).toThrow('写一下 Neo 要做什么。');
  });

  it('submits leading @neo through the renderer tag service boundary (直接开干)', async () => {
    const runNeoTag = vi.fn(async (input: CreateNeoWorkCardDraftRequest) => ({
      detail: makeDetail(input),
      sourceTurnId: 'turn-1',
    }));

    const result = await submitNeoTagDraft({
      envelope: { content: '@neo 做一件事' },
      sourceConversationId: 'session-1',
      projectId: 'project-1',
      requesterUserId: 'user-1',
      runNeoTag,
    });

    expect(runNeoTag).toHaveBeenCalledTimes(1);
    expect(runNeoTag.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project-1',
      userText: '做一件事',
      revision: {
        taskSummary: '做一件事',
      },
    });
    expect(result?.detail.workCard.id).toBe('card-1');
  });

  it('builds the local user message so the @neo turn shows what the user typed (BUG1)', () => {
    const request: CreateNeoWorkCardDraftRequest = buildNeoWorkCardDraftRequest({
      envelope: { content: '@neo 做一件事' },
      sourceConversationId: 'session-1',
      projectId: 'project-1',
      requesterUserId: 'user-1',
    })!;
    const attachments = [{ id: 'att-1', name: 'a.png', category: 'image' } as never];

    const message = buildNeoTagSourceMessage({
      envelope: { content: '@neo 做一件事', attachments },
      sourceConversationId: 'session-1',
      result: { detail: makeDetail(request), sourceTurnId: 'turn-1' },
      timestamp: 1234,
    });

    expect(message).toMatchObject({
      id: 'turn-1',
      role: 'user',
      content: '@neo 做一件事',
      timestamp: 1234,
      metadata: {
        neoTag: {
          workCardId: 'card-1',
          sourceConversationId: 'session-1',
          sourceTurnId: 'turn-1',
        },
      },
    });
    expect(message.attachments).toEqual(attachments);
  });
});

describe('Neo tag continuation submit (ADR-035)', () => {
  const target = { workCardId: 'nwc_1', title: '整理竞品报告' };
  const fakeResult = () => ({
    detail: makeDetail({
      projectId: 'proj_1',
      sourceConversationId: 'conv_A',
      requesterUserId: 'user_1',
      userText: 'x',
      title: '整理竞品报告',
      revision: {
        intent: 'plan',
        taskSummary: 'x',
        readScope: { mode: 'selected_context' },
        writeScope: { mode: 'none' },
        memoryPlan: { mode: 'none', entries: [], notes: [] },
      },
    } as never),
    roundTurnId: 'turn_round2',
  });

  it('strips optional @neo prefix and calls runContinuation with the round payload', async () => {
    const runContinuation = vi.fn(async () => fakeResult());
    const result = await submitNeoTagContinuation({
      envelope: { content: '@neo 补上定价维度' },
      conversationId: 'conv_B',
      continuationTarget: target,
      requesterUserId: 'user_1',
      runContinuation,
    });
    expect(runContinuation).toHaveBeenCalledWith(expect.objectContaining({
      workCardId: 'nwc_1',
      conversationId: 'conv_B',
      userText: '补上定价维度',
    }));
    expect(result.roundTurnId).toBe('turn_round2');
  });

  it('works without @neo prefix — the chip itself is the intent', async () => {
    const runContinuation = vi.fn(async (_input: ContinueNeoWorkCardRequest) => fakeResult());
    await submitNeoTagContinuation({
      envelope: { content: '补上定价维度' },
      conversationId: 'conv_B',
      continuationTarget: target,
      requesterUserId: 'user_1',
      runContinuation,
    });
    expect(runContinuation.mock.calls[0][0].userText).toBe('补上定价维度');
  });

  it('rejects empty text with a friendly error', async () => {
    await expect(submitNeoTagContinuation({
      envelope: { content: '@neo   ' },
      conversationId: 'conv_B',
      continuationTarget: target,
      requesterUserId: 'user_1',
      runContinuation: vi.fn(),
    })).rejects.toThrow();
  });

  it('buildNeoTagContinuationMessage anchors the local user message to roundTurnId + workCardId', () => {
    const message = buildNeoTagContinuationMessage({
      envelope: { content: '@neo 补上定价维度' },
      conversationId: 'conv_B',
      workCardId: 'nwc_1',
      roundTurnId: 'turn_round2',
    });
    expect(message.id).toBe('turn_round2');
    expect(message.role).toBe('user');
    expect(message.metadata?.neoTag?.workCardId).toBe('nwc_1');
    expect(message.metadata?.neoTag?.sourceConversationId).toBe('conv_B');
  });
});
