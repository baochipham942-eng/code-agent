import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readDevSurfaceExecutionConversationSeed,
} from '../../../src/web/routes/devSurfaceExecutionConversationSeed';

const roots: string[] = [];

function fixture(): { workspace: string; evidence: string; html: string; outside: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'surface-conversation-dev-route-'));
  roots.push(workspace);
  const evidenceRoot = join(workspace, 'docs/acceptance/surface-execution/conversation-current');
  mkdirSync(evidenceRoot, { recursive: true });
  const evidence = join(evidenceRoot, 'business-evidence.png');
  const html = join(evidenceRoot, 'travel-site-final.html');
  const outside = join(workspace, 'outside.png');
  writeFileSync(evidence, 'safe-evidence');
  writeFileSync(html, '<main data-deliverable="travel-site-final"></main>');
  writeFileSync(outside, 'outside');
  return { workspace, evidence, html, outside };
}

function seedPayload(evidence: string, html: string) {
  return {
    conversationId: 'conversation-1',
    evidenceAssetRef: evidence,
    outputHtmlAssetRef: html,
    outputImageAssetRef: evidence,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dev Surface Execution conversation seed boundary', () => {
  it('accepts only an existing regular artifact inside the acceptance root', () => {
    const { workspace, evidence, html } = fixture();

    expect(readDevSurfaceExecutionConversationSeed(
      seedPayload(realpathSync(evidence), realpathSync(html)),
      workspace,
    )).toEqual({
      conversationId: 'conversation-1',
      evidenceAssetRef: realpathSync(evidence),
      outputHtmlAssetRef: realpathSync(html),
      outputImageAssetRef: realpathSync(evidence),
    });
  });

  it('rejects authority-shaped extra fields and paths outside the acceptance root', () => {
    const { workspace, evidence, html, outside } = fixture();

    expect(() => readDevSurfaceExecutionConversationSeed({
      ...seedPayload(evidence, html),
      grantId: 'caller-controlled-grant',
    }, workspace)).toThrow(/accepts only/);
    expect(() => readDevSurfaceExecutionConversationSeed(
      seedPayload(outside, html),
      workspace,
    )).toThrow(/stay inside/);
  });

  it('rejects a symlink even when it points to an allowed acceptance artifact', () => {
    const { workspace, evidence, html } = fixture();
    const linked = join(workspace, 'docs/acceptance/surface-execution/conversation-current/linked.png');
    symlinkSync(evidence, linked);

    expect(() => readDevSurfaceExecutionConversationSeed(
      seedPayload(linked, html),
      workspace,
    )).toThrow(/regular acceptance artifact/);
  });
});
