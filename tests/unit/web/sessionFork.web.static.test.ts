import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../src/web/sessionDomainHandler.ts'),
  'utf8',
);

function caseBody(name: string): string {
  const start = source.indexOf(`case '${name}':`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\n        case '", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('web session Fork parity', () => {
  it('uses the same SessionForkService and never routes through checkpoint rewind/truncation', () => {
    const body = caseBody('fork');
    expect(body).toContain('SessionForkService');
    expect(body).toContain('service.createFork');
    expect(body).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
    expect(body).not.toContain('rewindFiles');
    expect(body).not.toContain('truncateMessagesAfter');
    expect(body).not.toContain('applyPromptRewind');
  });

  it('exposes lineage reads through the same service', () => {
    const lineage = caseBody('getForkLineage');
    const children = caseBody('listForkChildren');
    expect(lineage).toContain('.getLineage(sessionId)');
    expect(lineage).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
    expect(children).toContain('.listChildren(sessionId)');
    expect(children).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
  });
});

describe('web conversation Rewind parity', () => {
  it('uses SessionRewindService without coupling message visibility to file restore', () => {
    const body = caseBody('rewindToPrompt');
    expect(body).toContain('SessionRewindService');
    expect(body).toContain('.rewindConversation');
    expect(body).toContain('ownerUserId: getAuthService().getCurrentUser()?.id ?? null');
    expect(body).toContain("const isLegacyRewind = action === 'rewindToPrompt'");
    expect(body).toContain('!isLegacyRewind && !suppliedIdempotencyKey');
    expect(body).not.toContain('getFileCheckpointService');
    expect(body).not.toContain('rewindFiles');
  });

  it('exposes explicit conversation recovery', () => {
    expect(caseBody('restoreConversationRewind')).toContain('.restoreConversation');
  });

  it('routes explicit workspace file restore through the shared application service', () => {
    const body = caseBody('restoreWorkspaceFilesAtCheckpoint');
    expect(body).toContain('AgentAppServiceImpl');
    expect(body).toContain('.restoreWorkspaceFilesAtCheckpoint');
    expect(body).not.toContain('SessionRewindService');
    expect(body).not.toContain('getFileCheckpointService');
    expect(body).not.toContain('rewindFiles');
  });
});

describe('web conversation lineage repair parity', () => {
  it('routes the public repair action to compatibility projection reconstruction', () => {
    const start = source.indexOf("} else if (action === 'repairConversationLineage') {");
    const end = source.indexOf("} else if (action === 'recordConversationEvaluationAttribution') {", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain('database.repairConversationLineage({');
    expect(body).toContain('sessionId,');
    expect(body).toContain('boundary,');
    expect(body).toContain('issueDigest:');
    expect(body).toContain('reason:');
    expect(body).toContain('idempotencyKey:');
    expect(body).not.toContain('recordConversationLineageRepairOverride');
  });
});
