import { describe, expect, it, vi } from 'vitest';
import type { ConversationReplayMessage } from '../../../../src/shared/contract/conversationBranch';
import type { Message } from '../../../../src/shared/contract/message';
import { sanitizeConversationMessageSnapshot } from '../../../../src/host/services/core/conversationMessageSnapshot';
import { restoreLocalMessageContent } from '../../../../src/host/services/infra/sessionMessagePresentation';

const local: Message = {
  id: 'story-message',
  role: 'assistant',
  timestamp: 1,
  content: 'Journey\n```mermaid\nflowchart LR\nA --> B\n```\nAcceptance',
};
function entry(): ConversationReplayMessage {
  return {
    ordinal: 1,
    entryId: 'entry-story',
    projectedMessageId: local.id,
    sourceSessionId: 'session-story',
    sourceMessageId: local.id,
    aliasKind: 'native',
    message: sanitizeConversationMessageSnapshot(local),
  };
}

describe('local replay message presentation', () => {
  it('restores a generated diagram without changing the immutable snapshot', () => {
    const replay = entry();
    const before = structuredClone(replay);
    const read = vi.fn(() => local);
    expect(restoreLocalMessageContent('session-story', replay, read).content).toBe(local.content);
    expect(read).toHaveBeenCalledWith('session-story', local.id);
    expect(replay).toEqual(before);
    expect(replay.message.content).not.toContain('A --> B');
  });

  it.each(['chart', 'spreadsheet', 'html', 'generative_ui', 'neo_ui', 'question-form'])(
    'restores a local %s block while leaving the ledger payload-free', (language) => {
      const projection = { ...local, content: local.content.replace('mermaid', language) };
      const replay = { ...entry(), message: sanitizeConversationMessageSnapshot(projection) };
      expect(restoreLocalMessageContent('session-story', replay, () => projection).content).toBe(projection.content);
      expect(replay.message.content).not.toContain('A --> B');
    },
  );

  it.each([
    { sourceSessionId: 'another-session' },
    { sourceMessageId: 'another-message' },
    { projectedMessageId: 'another-message' },
    { aliasKind: 'fork_copy' as const },
  ])('does not fetch payloads across lineage boundaries: %j', (overrides) => {
    const replay = { ...entry(), ...overrides };
    const read = vi.fn(() => local);
    expect(restoreLocalMessageContent('session-story', replay, read)).toBe(replay.message);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...local, content: local.content + '\nUnrecorded claim' },
    { ...local, role: 'user' as const },
    { ...local, id: 'another-message' },
    { ...local, timestamp: 2 },
    { ...local, visibility: 'rewound' as const },
  ])('keeps the ledger when the local projection is absent or inconsistent: %j', (projection) => {
    const replay = entry();
    expect(restoreLocalMessageContent('session-story', replay, () => projection)).toBe(replay.message);
  });

  it('never replaces ledger metadata or tools with mutable projection fields', () => {
    const replay = entry();
    const restored = restoreLocalMessageContent('session-story', replay, () => ({
      ...local,
      // 投影侧可能带着账本从未记录过的字段，这正是本用例要喂进去的东西。
      // 断言不变：restoreLocalMessageContent 必须把它们丢掉，只取 content。
      metadata: { unrecorded: true } as Message['metadata'],
      toolCalls: [],
    }));
    expect(restored).toEqual({ ...replay.message, content: local.content });
  });

  it('does not query local messages for ordinary text', () => {
    const replay = entry();
    replay.message.content = 'Plain answer';
    const read = vi.fn(() => local);
    expect(restoreLocalMessageContent('session-story', replay, read)).toBe(replay.message);
    expect(read).not.toHaveBeenCalled();
  });
});
