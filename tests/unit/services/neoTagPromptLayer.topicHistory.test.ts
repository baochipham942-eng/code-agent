import { describe, expect, it } from 'vitest';
import type { NeoTagRunContext, NeoWorkCardRevision } from '../../../src/shared/contract/tag';
import type { NeoTopicRound } from '../../../src/shared/neoTag/topicRounds';
import { buildNeoTagContextPack } from '../../../src/host/services/project/neoTagContextSelector';
import {
  buildNeoTagPromptLayer,
  TOPIC_HISTORY_MAX_TOKENS,
} from '../../../src/host/services/project/neoTagPromptLayer';

function revision(): NeoWorkCardRevision {
  return {
    id: 'rev_1',
    workCardId: 'nwc_1',
    revisionNumber: 1,
    intent: 'implement',
    taskSummary: 'follow-up work',
    readScope: {
      mode: 'selected_context',
      projectId: 'proj_1',
      conversationIds: ['conv_A', 'conv_B'],
      messageIds: [],
      artifactIds: [],
      fileGlobs: [],
      memoryEntryIds: [],
      notes: [],
    },
    writeScope: {
      mode: 'none',
      projectId: 'proj_1',
      allowedPaths: [],
      canCreateFiles: false,
      canModifyFiles: false,
      canWriteProjectMemory: false,
      externalDestinations: [],
      notes: [],
    },
    modelIntent: { mode: 'inherit_current' },
    memoryPlan: { mode: 'none', entries: [], notes: [] },
    expectedOutputs: [],
    risks: [],
    assumptions: [],
    createdByUserId: 'user_1',
    createdAt: 1,
  };
}

function runContext(over: Partial<NeoTagRunContext> = {}): NeoTagRunContext {
  const rev = revision();
  const pack = buildNeoTagContextPack({
    workCard: {
      id: 'nwc_1',
      projectId: 'proj_1',
      sourceConversationId: 'conv_A',
      sourceTurnId: 'turn_1',
      requesterUserId: 'user_1',
      title: 'topic',
      status: 'approved',
      currentRevisionId: rev.id,
      approvedRevisionId: rev.id,
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
    },
    revision: rev,
    messages: [],
    now: 10,
  });
  return {
    workCardId: 'nwc_1',
    projectId: 'proj_1',
    sourceConversationId: 'conv_A',
    sourceTurnId: 'turn_1',
    approvedRevisionId: rev.id,
    runId: 'run_1',
    contextPackId: pack.id,
    modelIntent: rev.modelIntent,
    contextPack: pack,
    ...over,
  };
}

describe('prompt layer topic history', () => {
  it('materialises prior rounds (request + final reply) into the prompt', () => {
    const rounds: NeoTopicRound[] = [
      { request: '@neo 整理竞品报告', reply: '第一轮结论：……', at: 10, conversationId: 'conv_A' },
    ];
    const prompt = buildNeoTagPromptLayer({ runContext: runContext(), revision: revision(), topicRounds: rounds });
    expect(prompt).toContain('Topic history');
    expect(prompt).toContain('整理竞品报告');
    expect(prompt).toContain('第一轮结论');
  });

  it('drops oldest rounds beyond the token budget and states the dropped count', () => {
    const big = 'x'.repeat(TOPIC_HISTORY_MAX_TOKENS * 8); // estimateTokens 保守估算下也必超预算
    const rounds: NeoTopicRound[] = [
      { request: '最老的轮', reply: big, at: 1, conversationId: 'conv_A' },
      { request: '最新的轮', reply: '短回复', at: 2, conversationId: 'conv_A' },
    ];
    const prompt = buildNeoTagPromptLayer({ runContext: runContext(), revision: revision(), topicRounds: rounds });
    expect(prompt).toContain('最新的轮');
    expect(prompt).not.toContain('最老的轮');
    expect(prompt).toMatch(/1 earlier round\(s\) omitted/);
  });

  it('states the topic home workspace when running cross-conversation', () => {
    const prompt = buildNeoTagPromptLayer({
      runContext: runContext({ targetConversationId: 'conv_B' }),
      revision: revision(),
      topicRounds: [],
      topicWorkspace: '/repo/project',
    });
    expect(prompt).toContain('Topic home workspace: /repo/project');
  });

  it('omits workspace note when running in the source conversation', () => {
    const prompt = buildNeoTagPromptLayer({
      runContext: runContext({ targetConversationId: 'conv_A' }),
      revision: revision(),
      topicRounds: [],
      topicWorkspace: '/repo/project',
    });
    expect(prompt).not.toContain('Topic home workspace');
  });

  it('omits the section entirely when no rounds and not cross-conversation (legacy prompt unchanged)', () => {
    const prompt = buildNeoTagPromptLayer({ runContext: runContext(), revision: revision() });
    expect(prompt).not.toContain('Topic history');
  });
});
