import { describe, expect, it, vi } from 'vitest';

import {
  SessionForkRuntimeContextService,
  type SessionForkRuntimeContextDatabase,
} from '../../../../src/host/services/sessionFork/context/SessionForkRuntimeContextService';
import type {
  SessionForkContextHandoffRecord,
  SessionForkContextSource,
} from '../../../../src/host/services/core/repositories/SessionForkRepository';

const digest = 'a'.repeat(64);

function database(): SessionForkRuntimeContextDatabase {
  const source = {
    lineage: {
      forkId: 'fork-1',
      rootSessionId: 'source',
      parentSessionId: 'source',
      childSessionId: 'child',
      sourceAnchorMessageId: 'a2',
      anchorChildMessageId: 'ca2',
      depth: 1,
      workspaceMode: 'shared_current',
      contextDeliveryMode: 'validated_context_handoff',
      status: 'completed',
      syncState: 'local_only',
      createdAt: 10,
    },
    sourcePrefixDigest: digest,
    mappedActivePrefix: [
      {
        ordinal: 0,
        sourceMessageId: 'u1',
        childMessageId: 'cu1',
        message: {
          id: 'cu1',
          role: 'user',
          content: 'question',
          timestamp: 1,
          visibility: 'active',
        },
      },
      {
        ordinal: 1,
        sourceMessageId: 'a2',
        childMessageId: 'ca2',
        message: {
          id: 'ca2',
          role: 'assistant',
          content: 'answer',
          timestamp: 2,
          visibility: 'active',
        },
      },
    ],
  } satisfies SessionForkContextSource;

  return {
    getSessionForkContextSource: vi.fn<
      SessionForkRuntimeContextDatabase['getSessionForkContextSource']
    >(() => source),
    prepareSessionForkContextHandoff: vi.fn<
      SessionForkRuntimeContextDatabase['prepareSessionForkContextHandoff']
    >((_forkId, _engine, payloadDigest) => ({
      forkId: 'fork-1',
      engine: 'codex_cli',
      payloadDigest,
      state: 'pending',
      attemptId: null,
      preparedAt: 20,
      dispatchStartedAt: null,
      consumedAt: null,
      error: null,
    } satisfies SessionForkContextHandoffRecord)),
    markSessionForkContextHandoffDispatching: vi.fn<
      SessionForkRuntimeContextDatabase['markSessionForkContextHandoffDispatching']
    >((_forkId, payloadDigest, attemptId) => ({
      forkId: 'fork-1',
      engine: 'codex_cli',
      payloadDigest,
      state: 'dispatching',
      attemptId,
      preparedAt: 20,
      dispatchStartedAt: 30,
      consumedAt: null,
      error: null,
    } satisfies SessionForkContextHandoffRecord)),
    markSessionForkContextHandoffConsumed: vi.fn<
      SessionForkRuntimeContextDatabase['markSessionForkContextHandoffConsumed']
    >((_forkId, payloadDigest, attemptId) => ({
      forkId: 'fork-1',
      engine: 'codex_cli',
      payloadDigest,
      state: 'consumed',
      attemptId,
      preparedAt: 20,
      dispatchStartedAt: 30,
      consumedAt: 40,
      error: null,
    } satisfies SessionForkContextHandoffRecord)),
  };
}

describe('SessionForkRuntimeContextService', () => {
  it('retries a pending handoff with the same semantic payload digest across clock changes', async () => {
    const db = database();
    let persistedDigest: string | undefined;
    vi.mocked(db.prepareSessionForkContextHandoff).mockImplementation((
      _forkId,
      _engine,
      payloadDigest,
    ) => {
      if (persistedDigest && persistedDigest !== payloadDigest) {
        throw new Error('pending handoff digest changed');
      }
      persistedDigest = payloadDigest;
      return {
        forkId: 'fork-1',
        engine: 'codex_cli',
        payloadDigest,
        state: 'pending',
        attemptId: null,
        preparedAt: 20,
        dispatchStartedAt: null,
        consumedAt: null,
        error: null,
      };
    });
    let now = 20;
    const service = new SessionForkRuntimeContextService(db, {
      createAttemptId: () => `attempt-${now}`,
      now: () => now++,
    });

    const first = await service.prepareFirstChildRun({
      childSessionId: 'child',
      engine: 'codex_cli',
      firstUserPrompt: 'continue',
      policy: {
        privacyMode: 'redact',
        tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
        allowInternalMessages: false,
        allowAttachmentProvenance: true,
        allowReadOnlyArtifactProvenance: true,
      },
    });
    const retry = await service.prepareFirstChildRun({
      childSessionId: 'child',
      engine: 'codex_cli',
      firstUserPrompt: 'continue',
      policy: {
        privacyMode: 'redact',
        tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
        allowInternalMessages: false,
        allowAttachmentProvenance: true,
        allowReadOnlyArtifactProvenance: true,
      },
    });

    expect(retry?.handoff.createdAt).not.toBe(first?.handoff.createdAt);
    expect(retry?.handoff.payloadDigest).toBe(first?.handoff.payloadDigest);
    expect(db.prepareSessionForkContextHandoff).toHaveBeenCalledTimes(2);
  });

  it('reuses the durable attempt when retrying an identical dispatching handoff', async () => {
    const base = database();
    let record: SessionForkContextHandoffRecord | null = null;
    const db = Object.assign(base, {
      getSessionForkContextHandoff: vi.fn(() => record),
    });
    vi.mocked(db.prepareSessionForkContextHandoff).mockImplementation((
      _forkId,
      engine,
      payloadDigest,
    ) => {
      record = {
        forkId: 'fork-1',
        engine: engine as 'codex_cli' | 'claude_code',
        payloadDigest,
        state: 'pending',
        attemptId: null,
        preparedAt: 20,
        dispatchStartedAt: null,
        consumedAt: null,
        error: null,
      };
      return record;
    });
    vi.mocked(db.markSessionForkContextHandoffDispatching).mockImplementation((
      _forkId,
      payloadDigest,
      attemptId,
    ) => {
      record = {
        ...record!,
        payloadDigest,
        state: 'dispatching',
        attemptId,
        dispatchStartedAt: 30,
      };
      return record;
    });
    const policy = {
      privacyMode: 'redact' as const,
      tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
      allowInternalMessages: false,
      allowAttachmentProvenance: true,
      allowReadOnlyArtifactProvenance: true,
    };
    const first = await new SessionForkRuntimeContextService(db, {
      createAttemptId: () => 'attempt-original',
      now: () => 20,
    }).prepareFirstChildRun({
      childSessionId: 'child',
      engine: 'codex_cli',
      firstUserPrompt: 'continue',
      policy,
    });
    await first?.onDispatchStart();

    const retry = await new SessionForkRuntimeContextService(db, {
      createAttemptId: () => 'attempt-must-not-replace',
      now: () => 99,
    }).prepareFirstChildRun({
      childSessionId: 'child',
      engine: 'codex_cli',
      firstUserPrompt: 'continue',
      policy,
    });

    expect(retry?.handoff.payloadDigest).toBe(first?.handoff.payloadDigest);
    expect(retry?.attemptId).toBe('attempt-original');
    expect(db.prepareSessionForkContextHandoff).toHaveBeenCalledTimes(1);
    await retry?.onDispatchStart();
    expect(db.markSessionForkContextHandoffDispatching).toHaveBeenLastCalledWith(
      'fork-1',
      first?.handoff.payloadDigest,
      'attempt-original',
      99,
    );
  });

  it('permits fork-child resume only after the matching engine handoff is consumed', () => {
    const db = Object.assign(database(), {
      getSessionForkContextHandoff: vi.fn(() => ({
        forkId: 'fork-1',
        engine: 'codex_cli' as const,
        payloadDigest: digest,
        state: 'consumed' as const,
        attemptId: 'attempt-1',
        preparedAt: 20,
        dispatchStartedAt: 30,
        consumedAt: 40,
        error: null,
      })),
    });
    const service = new SessionForkRuntimeContextService(db);

    expect(() => service.assertConsumedForResume('child', 'codex_cli')).not.toThrow();
  });

  it.each(['pending', 'dispatching', 'blocked'] as const)(
    'fails closed when fork-child resume sees a %s handoff',
    (state) => {
      const db = Object.assign(database(), {
        getSessionForkContextHandoff: vi.fn(() => ({
          forkId: 'fork-1',
          engine: 'codex_cli' as const,
          payloadDigest: digest,
          state,
          attemptId: state === 'pending' ? null : 'attempt-1',
          preparedAt: 20,
          dispatchStartedAt: state === 'pending' ? null : 30,
          consumedAt: null,
          error: null,
        })),
      });
      const service = new SessionForkRuntimeContextService(db);

      expect(() => service.assertConsumedForResume('child', 'codex_cli')).toThrowError(
        expect.objectContaining({ code: 'HANDOFF_NOT_CONSUMED' }),
      );
    },
  );

  it('builds a bounded external handoff and exposes durable dispatch callbacks', async () => {
    const db = database();
    const service = new SessionForkRuntimeContextService(db, {
      createAttemptId: () => 'attempt-1',
      now: () => 20,
    });

    const delivery = await service.prepareFirstChildRun({
      childSessionId: 'child',
      engine: 'codex_cli',
      firstUserPrompt: 'continue',
      policy: {
        privacyMode: 'redact',
        tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
        allowInternalMessages: false,
        allowAttachmentProvenance: true,
        allowReadOnlyArtifactProvenance: true,
      },
    });

    expect(delivery?.handoff.messages.map((message) => message.content)).toEqual(['question', 'answer']);
    expect(delivery?.handoff.sourceRuntimeIdentityCopied).toBe(false);
    await delivery?.onDispatchStart();
    await delivery?.onDispatched();
    expect(db.markSessionForkContextHandoffDispatching).toHaveBeenCalledWith(
      'fork-1',
      delivery?.handoff.payloadDigest,
      'attempt-1',
      20,
    );
    expect(db.markSessionForkContextHandoffConsumed).toHaveBeenCalledWith(
      'fork-1',
      delivery?.handoff.payloadDigest,
      'attempt-1',
      20,
    );
  });

  it('returns null for an ordinary non-fork session', async () => {
    const db = database();
    vi.mocked(db.getSessionForkContextSource).mockReturnValue(null);
    const service = new SessionForkRuntimeContextService(db);

    await expect(service.prepareFirstChildRun({
      childSessionId: 'ordinary',
      engine: 'codex_cli',
      firstUserPrompt: 'hello',
      policy: {
        privacyMode: 'redact',
        tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
        allowInternalMessages: false,
        allowAttachmentProvenance: true,
        allowReadOnlyArtifactProvenance: true,
      },
    })).resolves.toBeNull();
    expect(db.prepareSessionForkContextHandoff).not.toHaveBeenCalled();
  });
});
