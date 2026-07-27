import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../../src/web/webServer.ts'),
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
});
