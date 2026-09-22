import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type { Session } from '../../../src/shared/contract/session';

const summarize = vi.hoisted(() => vi.fn(async () => 'Topics: cache\nSummary:\nkept the facts'));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: summarize,
}));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        get: () => undefined,
        run: () => ({ changes: 1 }),
      }),
    }),
  }),
}));

import { resolveSessionReference } from '../../../src/host/tools/modules/session/sessionReferenceDigest';

function message(index: number): Message {
  return {
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `line ${index}`,
    timestamp: 1_700_000_000_000 + index,
  } as Message;
}

describe('session reference digest cache contract', () => {
  beforeEach(() => {
    summarize.mockClear();
  });

  it('passes cacheRetention none and a record-only scope id', async () => {
    const session = { id: `session-${Date.now()}`, title: 'Referenced' } as Session;
    const messages = Array.from({ length: 16 }, (_, index) => message(index));

    await resolveSessionReference(session, messages);

    expect(summarize).toHaveBeenCalledWith(
      expect.stringContaining('Referenced'),
      800,
      { cacheRetention: 'none', cacheScopeId: 'session-reference-digest' },
    );
  });
});
