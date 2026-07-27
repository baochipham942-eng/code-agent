import { describe, expect, it } from 'vitest';
import {
  SessionForkPortabilityError,
  buildForkLineageEnvelopeV1,
  buildSessionExportEnvelopeV2,
  decodeForkLineageEnvelopeV1,
  decodeSessionExportEnvelopeV2,
  encodeForkLineageEnvelopeV1,
  encodeSessionExportEnvelopeV2,
  rehashSessionExportEnvelopeV2,
  stripLegacyForkClaims,
} from '../../../../../src/host/services/sessionFork/portability';
import { OWNER_ID, PROJECT_ID, message, session, subtreeDraft } from './fixture';

describe('session fork portability codecs', () => {
  it('builds a versioned subtree envelope and strips runtime and private payloads', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    expect(envelope.schema).toBe('neo.session-export');
    expect(envelope.version).toBe(2);
    expect(envelope.lineage?.schema).toBe('neo.fork-lineage');
    expect(envelope.lineage?.version).toBe(1);

    const child = envelope.sessions.find((item) => item.id === 'child');
    expect(child).toMatchObject({
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
      engine: {
        kind: 'codex_cli',
        model: 'gpt-test',
        permissionProfile: 'workspace_write',
      },
    });
    expect(child).not.toHaveProperty('parentSessionId');
    expect(child).not.toHaveProperty('workingDirectory');
    expect(child).not.toHaveProperty('sourceRunId');
    expect(child).not.toHaveProperty('streamSnapshot');
    expect(child?.engine).not.toHaveProperty('runId');
    expect(child?.engine).not.toHaveProperty('externalSessionId');
    expect(child?.engine).not.toHaveProperty('logPath');
    expect(child?.modelConfig).not.toHaveProperty('apiKey');
    expect(child?.modelConfig).not.toHaveProperty('baseUrl');
    expect(child?.workspace?.isolatedAnchor).not.toHaveProperty('absoluteWorktreePath');

    const childMessage = envelope.messages.find((item) => item.id === 'ca1');
    expect(childMessage?.attachments).toEqual([{
      id: 'attachment-1',
      type: 'file',
      category: 'text',
      name: 'secret.txt',
      size: 12,
      mimeType: 'text/plain',
    }]);
    expect(childMessage?.artifacts?.[0]).toMatchObject({
      id: 'artifact-1',
      type: 'document',
      title: 'Read only evidence',
      version: 2,
    });
    expect(childMessage?.artifacts?.[0]).not.toHaveProperty('content');

    const serialized = encodeSessionExportEnvelopeV2(envelope);
    expect(serialized).not.toContain('must-not-export');
    expect(serialized).not.toContain('external-child');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('secret body');
    expect(serialized).not.toContain('artifact body');
    expect(decodeSessionExportEnvelopeV2(serialized, {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toEqual(envelope);
  });

  it('roundtrips a standalone lineage envelope with stable encoding', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const lineage = buildForkLineageEnvelopeV1(envelope.lineage!);

    const first = encodeForkLineageEnvelopeV1(lineage);
    const second = encodeForkLineageEnvelopeV1(decodeForkLineageEnvelopeV1(first, {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
      sessionIds: new Set(['root', 'child']),
      messageIds: new Set(['u1', 'a1', 'cu1', 'ca1']),
    }));
    expect(second).toBe(first);
  });

  it('rejects owner, project, digest, ordinal, and reference-closure violations', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify({
      ...envelope,
      ownerScopeId: 'attacker',
    }), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrowError(SessionForkPortabilityError);

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify({
      ...envelope,
      projectId: 'other-project',
    }), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/PROJECT_SCOPE_MISMATCH/);

    const brokenDigest = structuredClone(envelope);
    brokenDigest.messages[0].content = 'tampered';
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(brokenDigest), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/DIGEST_MISMATCH/);

    const brokenOrdinal = structuredClone(envelope);
    brokenOrdinal.messages.find((item) => item.sessionId === 'child')!.ordinal = 7;
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(brokenOrdinal), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/ORDINAL_INVALID/);

    const brokenReference = structuredClone(envelope);
    brokenReference.lineage!.messageMappings[0].sourceMessageId = 'missing-message';
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(brokenReference), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/REFERENCE_NOT_CLOSED/);
  });

  it('represents a single child as detached provenance without claiming an attached parent', () => {
    const draft = subtreeDraft();
    const envelope = buildSessionExportEnvelopeV2({
      ...draft,
      mode: 'detached_child',
      rootSessionId: 'child',
      sessions: [draft.sessions[1]],
      lineage: undefined,
      detachedProvenance: {
        sourceRootSessionId: 'root',
        sourceParentSessionId: 'root',
        sourceForkId: 'fork-1',
        sourceAnchorMessageId: 'a1',
        sourceAnchorDigest: `sha256:${'6'.repeat(64)}`,
        sourceDepth: 1,
      },
    });

    expect(envelope.sessions).toHaveLength(1);
    expect(envelope.sessions[0]).not.toHaveProperty('parentSessionId');
    expect(envelope.lineage?.nodes).toEqual([
      expect.objectContaining({
        sessionId: 'child',
        parentSessionId: null,
        depth: 0,
      }),
    ]);
    expect(envelope.detachedProvenance).toMatchObject({
      sourceParentSessionId: 'root',
      sourceForkId: 'fork-1',
    });
  });

  it('strips legacy parentSessionId and forkLineage claims instead of trusting fake lineage', () => {
    const payload = {
      id: 'legacy-child',
      title: 'Imported legacy session',
      parentSessionId: 'fake-parent',
      forkLineage: { rootSessionId: 'fake-root', depth: 99 },
      metadata: {
        forkLineage: { forkId: 'fake-fork' },
        ordinary: 'keep',
      },
      sessions: [{
        id: 'nested',
        parentSessionId: 'fake-parent-2',
        forkLineage: { forkId: 'fake-fork-2' },
      }],
    };

    const result = stripLegacyForkClaims(payload);
    expect(result.value).toEqual({
      id: 'legacy-child',
      title: 'Imported legacy session',
      metadata: { ordinary: 'keep' },
      sessions: [{ id: 'nested' }],
    });
    expect(result.strippedPaths).toEqual([
      '$.forkLineage',
      '$.metadata.forkLineage',
      '$.parentSessionId',
      '$.sessions[0].forkLineage',
      '$.sessions[0].parentSessionId',
    ]);
  });

  it('rejects forbidden runtime fields even when an attacker recomputes every digest', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const malicious = structuredClone(envelope);
    (malicious.sessions[0] as unknown as Record<string, unknown>).approvalRequests = [{
      requestId: 'approval-1',
      approved: true,
    }];
    const rehashed = rehashSessionExportEnvelopeV2(malicious);

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(rehashed), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/RUNTIME_IDENTITY_FORBIDDEN/);
  });

  it('fails closed when detached mode has more than one session or lacks provenance', () => {
    const draft = subtreeDraft();
    expect(() => buildSessionExportEnvelopeV2({
      ...draft,
      mode: 'detached_child',
      lineage: undefined,
      detachedProvenance: undefined,
    })).toThrow(/DETACHED_PROVENANCE_REQUIRED/);

    expect(() => buildSessionExportEnvelopeV2({
      ...draft,
      mode: 'detached_child',
      sessions: [{
        session: session('only-child'),
        messages: [message('only-message', 'assistant', 'done', 1)],
      }],
      rootSessionId: 'only-child',
      lineage: undefined,
      detachedProvenance: undefined,
    })).toThrow(/DETACHED_PROVENANCE_REQUIRED/);
  });
});
