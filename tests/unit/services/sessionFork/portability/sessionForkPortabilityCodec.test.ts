import { describe, expect, it } from 'vitest';
import {
  SessionForkPortabilityError,
  buildForkLineageEnvelopeV1,
  buildPortableConversationHistory,
  buildSessionExportEnvelopeV2,
  decodeForkLineageEnvelopeV1,
  decodeSessionExportEnvelopeV2,
  encodeForkLineageEnvelopeV1,
  encodePortableConversationHistory,
  encodeSessionExportEnvelopeV2,
  rehashSessionExportEnvelopeV2,
  stripLegacyForkClaims,
  validatePortableIsolatedAnchorEvidenceV1,
} from '../../../../../src/host/services/sessionFork/portability';
import {
  PORTABLE_ANCHOR_MAX_PATCH_BYTES,
} from '../../../../../src/shared/contract/sessionForkPortability';
import type { Message } from '../../../../../src/shared/contract/message';
import { OWNER_ID, PROJECT_ID, message, session, subtreeDraft } from './fixture';

describe('session fork portability codecs', () => {
  it('builds a versioned subtree envelope and strips runtime and private payloads', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());

    expect(envelope.schema).toBe('neo.session-export');
    expect(envelope.version).toBe(3);
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
    expect(child?.workspace?.isolatedAnchor).toMatchObject({
      workspaceScopeVersion: 'scope-v1',
      content: {
        version: 1,
        stagedPatch: {
          blobDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        unstagedPatch: {
          blobDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
        untrackedFiles: [
          expect.objectContaining({
            relativePath: 'new.bin',
            blobDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
            mode: 0o600,
          }),
        ],
        blobs: expect.any(Object),
        payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    });
    expect(child?.workspace?.anchorChildMessageId).toBe('ca1');

    const childMessage = envelope.messages.find((item) => item.id === 'ca1');
    expect(childMessage).toMatchObject({
      contentParts: [
        { type: 'text', text: 'world' },
        { type: 'tool_call', toolCallId: 'call-ca1' },
      ],
      thinking: 'private reasoning',
    });
    // message.metadata is a free-form runtime blob and is not part of the portable
    // envelope at all (N-FORK-PORTABILITY round 3) — contentParts/toolCalls already
    // carry what rendering needs.
    expect(childMessage).not.toHaveProperty('metadata');
    expect(childMessage?.attachments).toEqual([expect.objectContaining({
      id: 'attachment-1',
      type: 'file',
      category: 'text',
      name: 'secret.txt',
      size: 12,
      mimeType: 'text/plain',
      contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    })]);
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

  it('rejects a foreign envelope smuggling toolCalls[].result.outputPath past decode', () => {
    // sanitizeToolCall never copies result.outputPath (a local filesystem path), so a
    // real export can't produce this shape. But nothing stopped decode from accepting
    // it from an untrusted wire envelope before this fix — the digest is self-computed,
    // so an attacker who recomputes it after adding the field would sail through.
    // assertOnlyKeys on the toolCalls/toolResults elements is what actually closes it.
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const foreign = {
      ...envelope,
      messages: envelope.messages.map((item) => (
        item.id === 'ca1' && item.toolCalls
          ? {
            ...item,
            toolCalls: item.toolCalls.map((call) => ({
              ...call,
              result: { ...call.result, success: true, outputPath: '/Users/private/.env' },
            })),
          }
          : item
      )),
    };

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(foreign), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/outputPath is not part of the portable schema/u);
  });

  it('rejects a foreign envelope smuggling toolResults[].outputPath past decode', () => {
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    const ca1 = childEntry.messages.find((entry) => entry.id === 'ca1')!;
    ca1.toolResults = [{ toolCallId: 'call-ca1', success: true }];
    const envelope = buildSessionExportEnvelopeV2(draft);
    const foreign = {
      ...envelope,
      messages: envelope.messages.map((item) => (
        item.id === 'ca1' && item.toolResults
          ? {
            ...item,
            toolResults: item.toolResults.map((result) => ({
              ...result,
              outputPath: '/Users/private/.env',
            })),
          }
          : item
      )),
    };

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(foreign), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/outputPath is not part of the portable schema/u);
  });

  it('never exports message.metadata, including turnDiff/retryAttachments/artifactLocator/channel leaks', () => {
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    const ca1 = childEntry.messages.find((entry) => entry.id === 'ca1')!;
    const dirtyMetadata: Message['metadata'] = {
      ...ca1.metadata,
      releaseNotes: 'kept because it only contains the substring "lease"',
      turnDiff: {
        turnId: 'turn-1',
        files: [{
          filePath: '/Users/private/worktrees/child/src/index.ts',
          oldText: 'const secretMarkerOld = 1;',
          newText: 'const secretMarkerNew = 2;',
          added: 1,
          removed: 1,
          isNewFile: false,
          editCount: 1,
        }],
      },
      retryAttachments: [{
        id: 'retry-attachment-1',
        type: 'file',
        category: 'text',
        name: 'retry.txt',
        size: 4,
        mimeType: 'text/plain',
        data: 'c2VjcmV0LWJhc2U2NC1wYXlsb2Fk',
      }],
      // N-FORK-PORTABILITY round 2 Important 1: artifactLocator.artifact.filePath is an
      // absolute local path (localityFeedback.ts) and channel.accountName/chatName carry
      // real person/group names (agentAppService.ts writes ChannelMessageMetadata) — both
      // leaked through the round-1 denylist unchanged.
      artifactLocator: {
        version: 1,
        artifact: {
          kind: 'presentation',
          filePath: '/Users/private/worktrees/child/deck.pptx',
          revision: { algorithm: 'sha256', value: 'a'.repeat(64) },
        },
        target: {
          kind: 'ppt-slide',
          displayIndex: 0,
          relationshipId: 'rId2',
          slidePartName: 'ppt/slides/slide1.xml',
          textFingerprint: 'fp',
        },
        display: { label: 'Slide 1' },
      },
      channel: {
        platform: 'feishu',
        accountId: 'account-1',
        accountName: 'Ada Placeholder',
        chatId: 'chat-1',
        chatName: 'Secret Working Group',
      },
    } as Message['metadata'];
    ca1.metadata = dirtyMetadata;

    const envelope = buildSessionExportEnvelopeV2(draft);
    const childMessage = envelope.messages.find((item) => item.id === 'ca1');

    // The whole message.metadata field is excluded from the portable envelope (see
    // codec.ts sanitizeMessages) — no denylist scrub needed because nothing crosses over.
    expect(childMessage).not.toHaveProperty('metadata');

    const serialized = encodeSessionExportEnvelopeV2(envelope);
    expect(serialized).not.toContain('/Users/private/worktrees/child/src/index.ts');
    expect(serialized).not.toContain('secretMarkerOld');
    expect(serialized).not.toContain('secretMarkerNew');
    expect(serialized).not.toContain('c2VjcmV0LWJhc2U2NC1wYXlsb2Fk');
    expect(serialized).not.toContain('/Users/private/worktrees/child/deck.pptx');
    expect(serialized).not.toContain('Ada Placeholder');
    expect(serialized).not.toContain('Secret Working Group');
    expect(serialized).not.toContain('releaseNotes');
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

  it('treats a session export without a version as legacy v0 and fails loudly without a migration', () => {
    const legacy: Record<string, unknown> = {
      ...structuredClone(buildSessionExportEnvelopeV2(subtreeDraft())),
    };
    delete legacy.version;

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(legacy))).toThrow(
      /session export envelope version 0 has no registered migration to version 3/u,
    );
  });

  it('fails loudly for an unknown session export version', () => {
    const unknown = {
      ...buildSessionExportEnvelopeV2(subtreeDraft()),
      version: 99,
    };

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(unknown))).toThrow(
      /session export envelope has unknown version 99; current version is 3/u,
    );
  });

  it('rejects the previous v2 envelope with an unsupported schema version error', () => {
    const previous = {
      ...buildSessionExportEnvelopeV2(subtreeDraft()),
      version: 2,
    };

    try {
      decodeSessionExportEnvelopeV2(JSON.stringify(previous));
      throw new Error('expected v2 envelope to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionForkPortabilityError);
      expect((error as SessionForkPortabilityError).code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    }
  });

  it('rejects a v3 envelope with a payloadDigest that does not match its content', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const tampered = { ...envelope, payloadDigest: `sha256:${'0'.repeat(64)}` };

    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(tampered)))
      .toThrow(/DIGEST_MISMATCH/u);
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
    expect(envelope.sessions[0].workspace?.anchorChildMessageId).toBe('ca1');
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

  it('fails closed when isolated evidence omits content or carries tampered base64', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const missing = structuredClone(envelope);
    delete (missing.sessions.find((item) => item.id === 'child')?.workspace?.isolatedAnchor as {
      content?: unknown;
    }).content;
    const rehashedMissing = rehashSessionExportEnvelopeV2(missing);
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(rehashedMissing), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/PORTABLE_EVIDENCE_REQUIRED|INVALID_ENVELOPE/u);

    const tampered = structuredClone(envelope);
    const content = tampered.sessions.find((item) => item.id === 'child')
      ?.workspace?.isolatedAnchor?.content;
    expect(content).toBeTruthy();
    const stagedDigest = content!.stagedPatch.blobDigest;
    content!.blobs[stagedDigest] = Buffer.from('tampered').toString('base64');
    const rehashedTampered = rehashSessionExportEnvelopeV2(tampered);
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(rehashedTampered), {
      ownerScopeId: OWNER_ID,
      projectId: PROJECT_ID,
    })).toThrow(/DIGEST_MISMATCH/u);
  });

  it('rejects portable evidence budget, path, mode, and nested digest violations', () => {
    const envelope = buildSessionExportEnvelopeV2(subtreeDraft());
    const original = envelope.sessions.find((item) => item.id === 'child')
      ?.workspace?.isolatedAnchor;
    expect(original).toBeTruthy();

    const overBudget = structuredClone(original!);
    overBudget.content.stagedPatch.sizeBytes = PORTABLE_ANCHOR_MAX_PATCH_BYTES + 1;
    expect(() => validatePortableIsolatedAnchorEvidenceV1(overBudget))
      .toThrow(/PORTABLE_EVIDENCE_BUDGET_EXCEEDED/u);

    const absolutePath = structuredClone(original!);
    absolutePath.content.untrackedFiles[0].relativePath = '/private/new.bin';
    expect(() => validatePortableIsolatedAnchorEvidenceV1(absolutePath))
      .toThrow(/ABSOLUTE_WORKTREE_FORBIDDEN/u);

    const invalidMode = structuredClone(original!);
    invalidMode.content.untrackedFiles[0].mode = 0o1000;
    expect(() => validatePortableIsolatedAnchorEvidenceV1(invalidMode))
      .toThrow(/INVALID_ENVELOPE/u);

    const invalidBase64 = structuredClone(original!);
    invalidBase64.content.blobs[invalidBase64.content.stagedPatch.blobDigest] = '***';
    expect(() => validatePortableIsolatedAnchorEvidenceV1(invalidBase64))
      .toThrow(/DIGEST_MISMATCH/u);

    const nestedDigestMismatch = structuredClone(original!);
    nestedDigestMismatch.content.payloadDigest = `sha256:${'f'.repeat(64)}`;
    expect(() => validatePortableIsolatedAnchorEvidenceV1(nestedDigestMismatch))
      .toThrow(/DIGEST_MISMATCH/u);
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

  it('exports and round-trips a persisted {id,name}-only tool call without arguments', () => {
    // Regression for N-FORK-PORTABILITY round 11: AgentRunEventCollector persists tool
    // calls as {id,name} with no `arguments`; 99/1581 sessions in the production DB on
    // 2026-09-21 had this shape. Requiring `arguments` made those sessions unexportable
    // (INVALID_ENVELOPE) while origin/main (which did not export toolCalls) exported fine.
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    childEntry.messages.push(message('bare-call-msg', 'assistant', 'ran bash', 3, {
      toolCalls: [{ id: 'toolu_bare', name: 'Bash' }],
    } as unknown as Partial<Message>));

    const envelope = buildSessionExportEnvelopeV2(draft);
    const bare = envelope.messages.find((item) => item.id === 'bare-call-msg');
    expect(bare?.toolCalls).toEqual([{ id: 'toolu_bare', name: 'Bash' }]);
    const decoded = decodeSessionExportEnvelopeV2(encodeSessionExportEnvelopeV2(envelope));
    expect(decoded.messages.find((item) => item.id === 'bare-call-msg')?.toolCalls)
      .toEqual([{ id: 'toolu_bare', name: 'Bash' }]);
  });

  it('redacts credential-shaped keys and key=value secrets the same way in toolCalls[]/result.output/contentParts as in the conversationHistory projection', () => {
    // Regression for N-FORK-PORTABILITY round 9: sanitizePortableValue (this file) used to
    // be a weaker, independently-maintained rewrite of conversationHistory.ts's
    // redactSecretText/isForbiddenStructuralKey — it caught apiKey/sk-.../AKIA... but not
    // password/Authorization/cookie/credential or the `key=value` text form. A password in
    // toolCalls[].arguments or an `Authorization: ...` header in result.output would
    // therefore travel in plaintext through messages[] while the same content, exported via
    // conversationHistory, was already redacted. Both channels now share the same
    // key-forbidden and string-redaction primitives (see codec.ts's isForbiddenPortableKey).
    const secretShapes = {
      toolCalls: [{
        id: 'call-secret',
        name: 'http',
        arguments: { password: 'hunter2', note: 'Authorization: abc123' },
        result: { success: true, output: 'Authorization: abc123' },
      }],
      contentParts: [
        { type: 'text', text: 'Authorization: abc123' },
        { type: 'tool_call', toolCallId: 'call-secret', password: 'hunter2' },
      ],
    } as unknown as Partial<Message>;

    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    childEntry.messages.push(message('secret-msg', 'assistant', 'plain', 3, secretShapes));

    const envelope = buildSessionExportEnvelopeV2(draft);
    const serialized = encodeSessionExportEnvelopeV2(envelope);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc123');

    const secretMessage = envelope.messages.find((item) => item.id === 'secret-msg');
    expect(JSON.stringify(secretMessage?.toolCalls)).not.toContain('hunter2');
    expect(JSON.stringify(secretMessage?.toolCalls)).not.toContain('abc123');
    expect(JSON.stringify(secretMessage?.contentParts)).not.toContain('hunter2');
    expect(JSON.stringify(secretMessage?.contentParts)).not.toContain('abc123');
    // The password key stays and its value is masked by the argument sanitizer.
    // Reverse mutation: whole-key delete drops `password`, so the match below goes red.
    const secretCall = secretMessage?.toolCalls?.find((call) => call.id === 'call-secret');
    expect(secretCall?.arguments).toMatchObject({ password: '[REDACTED]' });

    // Same raw shapes, this time through the conversationHistory projection.
    const history = buildPortableConversationHistory({
      ownerUserId: OWNER_ID,
      projectId: PROJECT_ID,
      branches: [{
        id: 'br-root',
        session_id: 'root',
        owner_user_id: OWNER_ID,
        project_id: PROJECT_ID,
        root_branch_id: 'br-root',
        parent_branch_id: null,
        fork_id: null,
        anchor_entry_id: null,
        created_at: 0,
      }],
      entries: [{
        id: 'entry-secret',
        owner_user_id: OWNER_ID,
        project_id: PROJECT_ID,
        source_session_id: 'root',
        source_message_id: 'secret-msg',
        created_at: 3,
        payload_digest: 'source-secret',
        message_json: JSON.stringify({
          id: 'secret-msg',
          role: 'assistant',
          content: 'plain',
          timestamp: 3,
          ...secretShapes,
        }),
      }],
      references: [],
      events: [],
      evaluationAttributions: [],
    });
    const serializedHistory = encodePortableConversationHistory(history);
    expect(serializedHistory).not.toContain('hunter2');
    expect(serializedHistory).not.toContain('abc123');
  });

  it('keeps Read/Edit file_path arguments across export and import', () => {
    // N-FORK-TOOLARGS-KEYSTRIP: path-shaped argument keys used to be deleted
    // because `path` / `filepath` are structural markers. The tool card then had
    // no target. Reverse mutation: send arguments through sanitizePortableValue
    // again and file_path disappears, so this assertion goes red.
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    childEntry.messages.push(message('path-call-msg', 'assistant', 'edited', 4, {
      toolCalls: [
        {
          id: 'toolu_read',
          name: 'Read',
          arguments: {
            file_path: '/tmp/neo-fork/readme.md',
            password: 'hunter2',
          },
        },
        {
          id: 'toolu_edit',
          name: 'Edit',
          arguments: { notebook_path: '/tmp/neo-fork/notes.ipynb' },
        },
        {
          id: 'toolu_read_file',
          name: 'read_file',
          arguments: { file_path: '/tmp/neo-fork/alias.md' },
        },
      ],
    } as unknown as Partial<Message>));

    const envelope = buildSessionExportEnvelopeV2(draft);
    const encoded = encodeSessionExportEnvelopeV2(envelope);
    expect(encoded).toContain('/tmp/neo-fork/readme.md');
    expect(encoded).toContain('/tmp/neo-fork/notes.ipynb');
    expect(encoded).toContain('/tmp/neo-fork/alias.md');
    expect(encoded).not.toContain('hunter2');

    const decoded = decodeSessionExportEnvelopeV2(encoded);
    const calls = decoded.messages.find((item) => item.id === 'path-call-msg')?.toolCalls;
    expect(calls?.find((call) => call.name === 'Read')?.arguments).toMatchObject({
      file_path: '/tmp/neo-fork/readme.md',
      password: '[REDACTED]',
    });
    expect(calls?.find((call) => call.name === 'Edit')?.arguments).toMatchObject({
      notebook_path: '/tmp/neo-fork/notes.ipynb',
    });
    expect(calls?.find((call) => call.name === 'read_file')?.arguments).toMatchObject({
      file_path: '/tmp/neo-fork/alias.md',
    });
  });

  it('masks nested and overlapping credential argument keys', () => {
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    childEntry.messages.push(message('nested-secret-msg', 'assistant', 'ran', 5, {
      toolCalls: [{
        id: 'toolu_nested',
        name: 'http',
        arguments: {
          password: { value: 'hunter2' },
          token: 123456,
          api_key_path: 'hunter2',
          file_path: '/tmp/neo-fork/keep.md',
        },
      }],
    } as unknown as Partial<Message>));

    const encoded = encodeSessionExportEnvelopeV2(buildSessionExportEnvelopeV2(draft));
    expect(encoded).not.toContain('hunter2');
    expect(encoded).not.toContain('123456');
    // http is not a file tool, so its path argument is masked with the credentials.
    expect(encoded).not.toContain('/tmp/neo-fork/keep.md');
    const decoded = decodeSessionExportEnvelopeV2(encoded);
    expect(decoded.messages.find((item) => item.id === 'nested-secret-msg')?.toolCalls?.[0]?.arguments)
      .toMatchObject({
        password: '[REDACTED]',
        token: '[REDACTED]',
        api_key_path: '[REDACTED]',
        file_path: '[REDACTED]',
      });
  });

  it('does not export an absolute path argument from a non-file tool', () => {
    const draft = subtreeDraft();
    const childEntry = draft.sessions.find((entry) => entry.session.id === 'child')!;
    childEntry.messages.push(message('http-path-msg', 'assistant', 'ran', 6, {
      toolCalls: [{
        id: 'toolu_http',
        name: 'http',
        arguments: { path: '/Users/private/.ssh/id_ed25519' },
      }],
    } as unknown as Partial<Message>));

    const encoded = encodeSessionExportEnvelopeV2(buildSessionExportEnvelopeV2(draft));
    expect(encoded).not.toContain('/Users/private/.ssh/id_ed25519');
    expect(encoded).not.toContain('.ssh');
  });
});
