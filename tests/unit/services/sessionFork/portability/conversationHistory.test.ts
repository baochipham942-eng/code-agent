import { afterEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';

import { applyConversationBranchSchema } from '../../../../../src/host/services/core/database/schemaConversationBranch';
import { ConversationBranchRepository } from '../../../../../src/host/services/core/repositories/ConversationBranchRepository';
import {
  buildPortableConversationHistory,
  decodePortableConversationHistory,
  encodePortableConversationHistory,
  planPortableConversationHistoryImport,
  PortableConversationHistoryError,
  rehashPortableConversationHistory,
  type ConversationHistorySourceRows,
  type PortableConversationReplayAction,
} from '../../../../../src/host/services/sessionFork/portability/conversationHistory';
import { portabilityDigest } from '../../../../../src/host/services/sessionFork/portability/canonical';

function sourceRows(): ConversationHistorySourceRows {
  const entries = [
    entry('e-u1', 's-root', 'm-u1', 'user', 'u1'),
    entry('e-a1', 's-root', 'm-a1', 'assistant', 'a1'),
    entry('e-a1r', 's-root', 'm-a1', 'assistant', 'a1 revised'),
    entry('e-pu', 's-root', 'm-pu', 'user', 'projected user'),
    entry('e-pa', 's-root', 'm-pa', 'assistant', 'projected assistant'),
    entry('e-u2', 's-child', 'c-u2', 'user', 'u2'),
    {
      ...entry('e-a2', 's-child', 'c-a2', 'assistant', [
        'a2',
        '```chart',
        '{"series":[1],"secret":"artifact-secret"}',
        '```',
      ].join('\n')),
      message_json: JSON.stringify({
        id: 'c-a2',
        role: 'assistant',
        content: [
          'a2',
          '```chart',
          '{"series":[1],"secret":"artifact-secret"}',
          '```',
        ].join('\n'),
        timestamp: 10,
        cwd: '/Users/private/worktree',
        metadata: {
          safe: 'retained',
          apiKey: 'provider-secret',
        },
        attachments: [{
          id: 'attachment-1',
          type: 'file',
          category: 'document',
          name: 'proof.pdf',
          size: 12,
          mimeType: 'application/pdf',
          path: '/Users/private/proof.pdf',
          bytes: 'raw-base64',
          apiKey: 'provider-secret',
        }],
        artifacts: [{
          id: 'artifact-1',
          type: 'chart',
          title: 'Private chart',
          version: 2,
          path: '/Users/private/chart.json',
          content: {
            series: [1],
            secret: 'artifact-secret',
          },
        }],
      }),
      provenance_json: JSON.stringify({
        kind: 'message_append',
        cwd: '/Users/private/worktree',
        authorization: 'Bearer provider-secret',
        safe: 'retained',
      }),
    },
  ];
  return {
    ownerUserId: 'owner-1',
    projectId: 'project-1',
    branches: [
      {
        id: 'br-child',
        session_id: 's-child',
        owner_user_id: 'owner-1',
        project_id: 'project-1',
        root_branch_id: 'br-root',
        parent_branch_id: 'br-root',
        fork_id: 'fork-1',
        anchor_entry_id: 'e-pa',
        created_at: 10,
      },
      {
        id: 'br-root',
        session_id: 's-root',
        owner_user_id: 'owner-1',
        project_id: 'project-1',
        root_branch_id: 'br-root',
        parent_branch_id: null,
        fork_id: null,
        anchor_entry_id: null,
        created_at: 1,
      },
    ],
    entries: entries.reverse(),
    references: [
      reference('br-child', 3, 'e-a2', 's-child', 'c-a2', 's-child', 'c-a2', 'native'),
      reference('br-root', 4, 'e-pa', 's-root', 'm-pa', 's-root', 'm-pa', 'replacement'),
      reference('br-child', 0, 'e-pu', 's-child', 'c-pu', 's-root', 'm-pu', 'fork_copy'),
      reference('br-root', 0, 'e-u1', 's-root', 'm-u1', 's-root', 'm-u1', 'native'),
      reference('br-child', 2, 'e-u2', 's-child', 'c-u2', 's-child', 'c-u2', 'native'),
      reference('br-root', 2, 'e-a1r', 's-root', 'm-a1', 's-root', 'm-a1', 'revision'),
      reference('br-child', 1, 'e-pa', 's-child', 'c-pa', 's-root', 'm-pa', 'fork_copy'),
      reference('br-root', 3, 'e-pu', 's-root', 'm-pu', 's-root', 'm-pu', 'replacement'),
      reference('br-root', 1, 'e-a1', 's-root', 'm-a1', 's-root', 'm-a1', 'native'),
    ],
    events: [
      event('ev-child-repair', 'br-child', 8, 'repair_override', {
        issueDigest: 'issue-digest',
        quarantineEventId: 'ev-child-quarantine',
        reason: 'Reviewed source evidence and accepted exact lineage repair.',
      }),
      event('ev-root-project', 'br-root', 4, 'projection_replace', {
        previousActiveOrdinals: [0, 2],
        projectedMessageIds: ['m-pu', 'm-pa'],
        payloadDigests: ['source-payload-u', 'source-payload-a'],
        reason: 'projection import fixture',
        replacementOrdinals: [3, 4],
      }),
      event('ev-child-fork', 'br-child', 1, 'fork', {
        forkId: 'fork-1',
        parentSessionId: 's-root',
        sourceAnchorMessageId: 'm-pa',
        childAnchorMessageId: 'c-pa',
        ordinals: [0, 1],
        entryIds: ['e-pu', 'e-pa'],
        aliases: [
          { sourceMessageId: 'm-pu', childMessageId: 'c-pu' },
          { sourceMessageId: 'm-pa', childMessageId: 'c-pa' },
        ],
      }),
      event('ev-child-restore', 'br-child', 5, 'rewind_restore', {
        rewindId: 'rewind-1',
      }),
      event('ev-root-a1', 'br-root', 2, 'append', {
        projectedMessageId: 'm-a1',
        ordinal: 1,
        entryId: 'e-a1',
      }),
      event('ev-child-eval', 'br-child', 6, 'evaluation_attribution', {
        evaluationId: 'evaluation-1',
        runId: 'provider-run-secret',
        metric: 'quality',
        value: 0.9,
        entryIds: ['e-a2'],
      }),
      event('ev-root-u1', 'br-root', 1, 'append', {
        projectedMessageId: 'm-u1',
        ordinal: 0,
        entryId: 'e-u1',
      }),
      event('ev-child-u2', 'br-child', 2, 'append', {
        projectedMessageId: 'c-u2',
        ordinal: 2,
        entryId: 'e-u2',
      }),
      event('ev-root-revision', 'br-root', 3, 'message_revision', {
        targetOrdinal: 1,
        targetEntryId: 'e-a1',
        projectedMessageId: 'm-a1',
        payloadDigest: 'source-payload-revised',
        reason: 'revision import fixture',
        replacementOrdinal: 2,
        replacementEntryId: 'e-a1r',
      }),
      event('ev-child-rewind', 'br-child', 4, 'rewind', {
        rewindId: 'rewind-1',
        anchorOrdinal: 2,
        anchorEntryId: 'e-u2',
        anchorMessageId: 'c-u2',
        hiddenMessageIds: ['c-a2'],
        hidden: [
          { ordinal: 3, entryId: 'e-a2', projectedMessageId: 'c-a2' },
        ],
      }),
      event('ev-child-a2', 'br-child', 3, 'append', {
        projectedMessageId: 'c-a2',
        ordinal: 3,
        entryId: 'e-a2',
      }),
      event('ev-child-quarantine', 'br-child', 7, 'quarantine', {
        issueDigest: 'issue-digest',
        issues: [{
          code: 'FORK_PREFIX_ENTRY_MISMATCH',
          detail: 'fixture issue',
          branchId: 'br-child',
        }],
      }),
    ],
    evaluationAttributions: [{
      event_id: 'ev-child-eval',
      branch_id: 'br-child',
      evaluation_id: 'evaluation-1',
      run_id: 'provider-run-secret',
      metric: 'quality',
      value: 0.9,
      entry_ids: JSON.stringify(['e-a2']),
      created_at: 10,
    }],
  };
}

function sourceRowsWithProjectionRepair(
  issues: Array<Record<string, unknown>> = [{
    code: 'PROJECTION_ALIAS_PAYLOAD_MISMATCH',
    detail: 'active compatibility alias diverged from its immutable entry',
    branchId: 'br-child',
    ordinal: 1,
    entryId: 'e-pa',
  }],
): ConversationHistorySourceRows {
  const source = sourceRows();
  const issueDigest = 'a'.repeat(64);
  return {
    ...source,
    events: source.events.map((row) => {
      if (row.id === 'ev-child-quarantine') {
        return event('ev-child-quarantine', 'br-child', 7, 'quarantine', {
          issueDigest,
          issues,
        });
      }
      if (row.id === 'ev-child-repair') {
        return event('ev-child-repair', 'br-child', 8, 'projection_repair', {
          issueDigest,
          quarantineEventId: 'ev-child-quarantine',
          reason: 'Rebuilt the compatibility projection from immutable replay evidence.',
          previousProjectionDigest: 'b'.repeat(64),
          repairedProjectionDigest: 'c'.repeat(64),
          expectedActiveCount: 4,
          previousActiveCount: 4,
          insertedCount: 0,
          updatedCount: 4,
          softHiddenCount: 0,
          reorderedCount: 0,
          recalibratedForkMappingCount: 0,
        });
      }
      return row;
    }),
  };
}

function entry(
  id: string,
  sessionId: string,
  messageId: string,
  role: 'user' | 'assistant',
  content: string,
): Record<string, unknown> {
  return {
    id,
    owner_user_id: 'owner-1',
    project_id: 'project-1',
    source_session_id: sessionId,
    source_message_id: messageId,
    message_json: JSON.stringify({
      id: messageId,
      role,
      content,
      timestamp: 10,
    }),
    payload_digest: `source-${id}`,
    provenance_json: JSON.stringify({ kind: 'message_append' }),
    created_at: 10,
  };
}

function reference(
  branchId: string,
  ordinal: number,
  entryId: string,
  sessionId: string,
  messageId: string,
  canonicalSessionId: string,
  canonicalMessageId: string,
  aliasKind: string,
): Record<string, unknown> {
  return {
    branch_id: branchId,
    ordinal,
    entry_id: entryId,
    projected_session_id: sessionId,
    projected_message_id: messageId,
    canonical_source_session_id: canonicalSessionId,
    canonical_source_message_id: canonicalMessageId,
    alias_kind: aliasKind,
    created_at: 10,
  };
}

function event(
  id: string,
  branchId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    branch_id: branchId,
    sequence,
    event_type: eventType,
    idempotency_key: `source:${id}`,
    actor_user_id: 'owner-1',
    payload_json: JSON.stringify(payload),
    payload_digest: `source-${id}`,
    previous_event_digest: sequence === 1 ? null : 'source-chain',
    event_digest: `source-event-${id}`,
    created_at: 10,
  };
}

const sessionIdMap = {
  's-root': 'target-root',
  's-child': 'target-child',
};

const messageIdMap = {
  'm-u1': 'target-u1',
  'm-a1': 'target-a1',
  'm-pu': 'target-pu',
  'm-pa': 'target-pa',
  'c-pu': 'target-c-pu',
  'c-pa': 'target-c-pa',
  'c-u2': 'target-c-u2',
  'c-a2': 'target-c-a2',
};

describe('portable P2 conversation history', () => {
  const databases: InstanceType<typeof Database>[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('builds deterministic digest-backed history while retaining only attachment/artifact provenance', () => {
    const source = sourceRows();
    const history = buildPortableConversationHistory(source);
    const rebuilt = buildPortableConversationHistory({
      ...source,
      branches: [...source.branches].reverse(),
      entries: [...source.entries].reverse(),
      references: [...source.references].reverse(),
      events: [...source.events].reverse(),
    });

    expect(rebuilt).toEqual(history);
    expect(history.branches.map((branch) => branch.sessionId)).toEqual(['s-root', 's-child']);
    expect(history.events.map((item) => `${item.branchId}:${item.sequence}`)).toEqual([
      'br-root:1',
      'br-root:2',
      'br-root:3',
      'br-root:4',
      'br-child:1',
      'br-child:2',
      'br-child:3',
      'br-child:4',
      'br-child:5',
      'br-child:6',
      'br-child:7',
      'br-child:8',
    ]);

    const encoded = encodePortableConversationHistory(history);
    expect(encoded).not.toContain('/Users/private');
    expect(encoded).not.toContain('provider-secret');
    expect(encoded).not.toContain('provider-run-secret');
    expect(encoded).not.toContain('artifact-secret');
    expect(encoded).not.toContain('raw-base64');
    expect(encoded).not.toContain('"bytes"');
    expect(encoded).toContain('payload omitted');
    expect(encoded).toContain('contentDigest');
    expect(encoded).toContain('idDigest');
    expect(encoded).toContain('"safe":"retained"');
    expect(decodePortableConversationHistory(encoded)).toEqual(history);

    const tampered = JSON.parse(encoded) as Record<string, unknown>;
    (tampered.branches as Array<Record<string, unknown>>)[0].sessionId = 'tampered';
    expect(() => decodePortableConversationHistory(JSON.stringify(tampered)))
      .toThrowError(PortableConversationHistoryError);
  });

  it('removes compound secret and local-path metadata keys recursively', () => {
    const source = sourceRows();
    const mutableEntries = source.entries.map((row) => ({ ...row }));
    source.entries = mutableEntries;
    const target = mutableEntries.find((row) => row.id === 'e-a2');
    if (!target) throw new Error('privacy fixture entry is missing');
    const message = JSON.parse(String(target.message_json)) as Record<string, unknown>;
    message.metadata = {
      safe: 'retained',
      nested: {
        visible: 'retained-too',
        accessToken: 'leak-access-token',
        ACCESS_TOKEN_BACKUP: 'leak-upper-access-token',
        'prefix-refresh-token-suffix': 'leak-refresh-token',
        authorizationHeader: 'leak-authorization',
        'provider-authorization-header-cache': 'leak-prefixed-authorization',
        logPath: '/Users/private/leak.log',
        LOG_PATH_ARCHIVE: '/Users/private/leak-archive.log',
      },
    };
    target.message_json = JSON.stringify(message);
    target.provenance_json = JSON.stringify({
      kind: 'message_append',
      safe: 'retained',
      nested: {
        visible: 'retained-too',
        providerAccessTokenCache: 'leak-provenance-token',
        refresh_token_backup: 'leak-provenance-refresh',
        requestAuthorizationHeader: 'leak-provenance-authorization',
        build_log_path_snapshot: '/Users/private/provenance.log',
      },
    });

    const encoded = encodePortableConversationHistory(buildPortableConversationHistory(source));
    for (const leakedValue of [
      'leak-access-token',
      'leak-upper-access-token',
      'leak-refresh-token',
      'leak-authorization',
      'leak-prefixed-authorization',
      'leak.log',
      'leak-archive.log',
      'leak-provenance-token',
      'leak-provenance-refresh',
      'leak-provenance-authorization',
      'provenance.log',
    ]) {
      expect(encoded).not.toContain(leakedValue);
    }
    const history = decodePortableConversationHistory(encoded);
    const entry = history.entries.find((item) => item.id === 'e-a2');
    expect(entry?.message.metadata).toEqual({
      safe: 'retained',
      nested: { visible: 'retained-too' },
    });
    expect(entry?.provenance).toEqual({
      kind: 'message_append',
      safe: 'retained',
      nested: { visible: 'retained-too' },
    });
  });

  it('rejects digest-valid imported history containing a compound private key', () => {
    const history = buildPortableConversationHistory(sourceRows());
    const sourceEvent = history.events[0];
    const { payloadDigest: _sourceEventDigest, ...unsignedEvent } = {
      ...sourceEvent,
      payload: {
        ...sourceEvent.payload,
        nested: {
          safe: 'retained',
          provider_access_token_backup: 'imported-secret',
        },
      },
    };
    const tamperedEvent = {
      ...unsignedEvent,
      payloadDigest: portabilityDigest(unsignedEvent),
    };
    const tamperedHistory = rehashPortableConversationHistory({
      ...history,
      events: [tamperedEvent, ...history.events.slice(1)],
    });

    expect(() => decodePortableConversationHistory(JSON.stringify(tamperedHistory)))
      .toThrowError(expect.objectContaining({
        code: 'PRIVACY_VIOLATION',
      }));
  });

  it('plans a stable, fully remapped advanced repository replay including repair history', () => {
    const history = buildPortableConversationHistory(sourceRows());
    const plan = planPortableConversationHistoryImport({
      history,
      sessionIdMap,
      messageIdMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    });

    expect(plan.actions.map((action) => action.method)).toEqual([
      'initializeSessionBranch',
      'appendMessage',
      'appendMessage',
      'recordMessageRevision',
      'recordProjectionReplacement',
      'createForkBranch',
      'appendMessage',
      'appendMessage',
      'recordRewind',
      'recordRewindRestore',
      'recordEvaluationAttribution',
      'auditAndQuarantine',
      'recordRepairOverride',
    ]);
    expect(plan.actions.map((action) => action.order)).toEqual(
      Array.from({ length: plan.actions.length }, (_item, index) => index),
    );

    const fork = plan.actions.find((action) => action.method === 'createForkBranch');
    expect(fork?.input).toMatchObject({
      sourceSessionId: 'target-root',
      childSessionId: 'target-child',
      sourceAnchorMessageId: 'target-pa',
      childAnchorMessageId: 'target-c-pa',
      forkId: 'target-fork-1',
      boundary: {
        ownerUserId: 'target-owner',
        projectId: 'target-project',
      },
      messageAliases: [
        { sourceMessageId: 'target-pu', childMessageId: 'target-c-pu' },
        { sourceMessageId: 'target-pa', childMessageId: 'target-c-pa' },
      ],
    });

    const rewind = plan.actions.find((action) => action.method === 'recordRewind');
    expect(rewind?.input).toMatchObject({
      sessionId: 'target-child',
      anchorMessageId: 'target-c-u2',
      hiddenMessageIds: ['target-c-a2'],
      rewindId: plan.rewindIdMap['rewind-1'],
    });
    const evaluation = plan.actions.find(
      (action) => action.method === 'recordEvaluationAttribution',
    );
    expect(evaluation?.input).toMatchObject({
      sessionId: 'target-child',
      evaluationId: plan.evaluationIdMap['evaluation-1'],
      runId: null,
      metric: 'quality',
      value: 0.9,
      attributedMessageIds: ['target-c-a2'],
    });
    const quarantine = plan.actions.find((action) => action.method === 'auditAndQuarantine');
    expect(quarantine).toMatchObject({
      expectedIssueDigest: 'issue-digest',
    });
    const repair = plan.actions.find((action) => action.method === 'recordRepairOverride');
    expect(repair?.input).toMatchObject({
      issueDigest: 'issue-digest',
      reason: 'Reviewed source evidence and accepted exact lineage repair.',
    });

    const childAppend = plan.actions.find((
      action,
    ): action is Extract<PortableConversationReplayAction, { method: 'appendMessage' }> => (
      action.method === 'appendMessage'
      && action.input.sessionId === 'target-child'
      && action.input.message.id === 'target-c-a2'
    ));
    if (!childAppend) throw new Error('child append replay action is missing');
    expect(JSON.stringify(childAppend)).not.toContain('/Users/private');
    expect(JSON.stringify(childAppend)).not.toContain('provider-secret');
    expect(childAppend.input.message).toMatchObject({
      id: 'target-c-a2',
      metadata: { safe: 'retained' },
    });
    expect(plan.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('defers a projection repair quarantine until it can derive fresh target evidence', () => {
    const history = buildPortableConversationHistory(sourceRowsWithProjectionRepair());
    const plan = planPortableConversationHistoryImport({
      history,
      sessionIdMap,
      messageIdMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    });

    expect(plan.actions.map((action) => action.method)).not.toContain('auditAndQuarantine');
    const repair = plan.actions.find((action) => action.method === 'repairCompatibilityProjection');
    expect(repair).toMatchObject({
      method: 'repairCompatibilityProjection',
      sourceEventId: 'ev-child-repair',
      input: {
        sessionId: 'target-child',
        boundary: {
          ownerUserId: 'target-owner',
          projectId: 'target-project',
        },
        reason: 'Rebuilt the compatibility projection from immutable replay evidence.',
      },
      sourceEvidence: {
        sourceIssueDigest: 'a'.repeat(64),
        sourceQuarantineEventId: 'ev-child-quarantine',
        issueTypes: ['PROJECTION_ALIAS_PAYLOAD_MISMATCH'],
      },
    });
    expect(repair && 'issueDigest' in repair.input).toBe(false);
    expect(repair && 'quarantineEventId' in repair.input).toBe(false);
  });

  it('fails closed when projection repair evidence is not projection-only and reference-closed', () => {
    const nonProjectionHistory = buildPortableConversationHistory(
      sourceRowsWithProjectionRepair([{
        code: 'FORK_PREFIX_ENTRY_MISMATCH',
        detail: 'unsafe structural issue',
        branchId: 'br-child',
      }]),
    );
    expect(() => planPortableConversationHistoryImport({
      history: nonProjectionHistory,
      sessionIdMap,
      messageIdMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    })).toThrow(/projection-only|FORK_PREFIX_ENTRY_MISMATCH/u);

    const missingIssueHistory = buildPortableConversationHistory(
      sourceRowsWithProjectionRepair([]),
    );
    expect(() => planPortableConversationHistoryImport({
      history: missingIssueHistory,
      sessionIdMap,
      messageIdMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    })).toThrow(/projection repair evidence|issue evidence|issues/u);
  });

  it('fails closed when an import mapping is not reference-closed', () => {
    const history = buildPortableConversationHistory(sourceRows());
    const { 'c-pa': _missing, ...incompleteMessageMap } = messageIdMap;
    expect(() => planPortableConversationHistoryImport({
      history,
      sessionIdMap,
      messageIdMap: incompleteMessageMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    })).toThrow(/MAPPING_MISSING|c-pa/u);
  });

  it('executes the replay plan through the real immutable repository APIs', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        project_id TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO sessions (id, user_id, project_id, created_at)
      VALUES
        ('target-root', 'target-owner', 'target-project', 1),
        ('target-child', 'target-owner', 'target-project', 10);
    `);
    applyConversationBranchSchema(db, { backfillLegacy: false });
    const repository = new ConversationBranchRepository(db, {
      auditCompatibilityProjection: false,
    });
    const plan = planPortableConversationHistoryImport({
      history: buildPortableConversationHistory(sourceRows()),
      sessionIdMap,
      messageIdMap,
      forkIdMap: { 'fork-1': 'target-fork-1' },
      targetOwnerUserId: 'target-owner',
      targetProjectId: 'target-project',
    });
    const executable = plan.actions.filter((action) => (
      action.method !== 'auditAndQuarantine'
      && action.method !== 'recordRepairOverride'
    ));
    for (const action of executable) applyReplayAction(repository, action);

    const boundary = { ownerUserId: 'target-owner', projectId: 'target-project' };
    expect(repository.replay('target-root', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['target-pu', 'target-pa']);
    expect(repository.replay('target-child', boundary).messages.map((message) => message.projectedMessageId))
      .toEqual(['target-c-pu', 'target-c-pa', 'target-c-u2', 'target-c-a2']);
    expect(repository.compareBranches({
      leftSessionId: 'target-root',
      rightSessionId: 'target-child',
      boundary,
    })).toMatchObject({ sharedPrefixLength: 2 });
    expect(repository.listEvaluationAttributions('target-child', boundary)).toMatchObject([{
      evaluationId: plan.evaluationIdMap['evaluation-1'],
      runId: null,
      metric: 'quality',
      value: 0.9,
    }]);
    expect(repository.auditLineage('target-child', boundary)).toMatchObject({
      status: 'healthy',
      issues: [],
    });

    const quarantine = plan.actions.find((action) => action.method === 'auditAndQuarantine');
    expect(quarantine).toBeDefined();
    expect(repository.auditLineage(
      quarantine!.input.sessionId,
      quarantine!.input.boundary,
    ).issueDigest).not.toBe(quarantine!.expectedIssueDigest);
    expect(repository.getRawLedgerCounts('target-child', boundary).events).toBe(6);
  });
});

function applyReplayAction(
  repository: ConversationBranchRepository,
  action: PortableConversationReplayAction,
): void {
  switch (action.method) {
    case 'initializeSessionBranch':
      repository.initializeSessionBranch(action.input);
      break;
    case 'appendMessage':
      repository.appendMessage(action.input);
      break;
    case 'recordMessageRevision':
      repository.recordMessageRevision(action.input);
      break;
    case 'recordProjectionReplacement':
      repository.recordProjectionReplacement(action.input);
      break;
    case 'createForkBranch':
      repository.createForkBranch(action.input);
      break;
    case 'recordRewind':
      repository.recordRewind(action.input);
      break;
    case 'recordRewindRestore':
      repository.recordRewindRestore(action.input);
      break;
    case 'recordEvaluationAttribution':
      repository.recordEvaluationAttribution(action.input);
      break;
    case 'auditAndQuarantine':
    case 'recordRepairOverride':
    case 'repairCompatibilityProjection':
      throw new Error(`guarded action ${action.method} requires an exact audit precondition`);
  }
}
