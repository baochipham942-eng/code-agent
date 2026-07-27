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
