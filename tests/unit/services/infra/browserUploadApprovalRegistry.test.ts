import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectBrowserUploadFile,
  RelayBrowserUploadApprovalRegistry,
} from '../../../../src/host/services/infra/browser/browserUploadApprovalRegistry';

const temporaryDirectories: string[] = [];

function temporaryFile(contents = 'approved browser upload fixture') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-approval-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'fixture.txt');
  fs.writeFileSync(filePath, contents);
  return { directory, filePath };
}

const owner = {
  conversationId: 'conversation-upload',
  runId: 'run-upload',
  agentId: 'agent-upload',
  operationId: 'operation-upload',
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('RelayBrowserUploadApprovalRegistry', () => {
  it('binds a one-time token to the exact conversation, run, agent, operation, and file bytes', () => {
    const { filePath } = temporaryFile();
    const registry = new RelayBrowserUploadApprovalRegistry(() => 1_000);
    const file = inspectBrowserUploadFile(filePath);
    const issued = registry.issue({ owner, file, ttlMs: 30_000 });

    expect(() => registry.consume({
      token: issued.token,
      owner: { ...owner, agentId: 'agent-attacker' },
    })).toThrow('SURFACE_APPROVAL_INVALID');

    const consumed = registry.consume({ token: issued.token, owner });
    expect(consumed).toEqual({ approvalRef: issued.approvalRef, file });
    expect(() => registry.consume({ token: issued.token, owner })).toThrow('SURFACE_APPROVAL_INVALID');
  });

  it('fails closed when the approved bytes change before consumption', () => {
    const { filePath } = temporaryFile('same-size-before');
    const registry = new RelayBrowserUploadApprovalRegistry(() => 1_000);
    const issued = registry.issue({ owner, file: inspectBrowserUploadFile(filePath) });
    fs.writeFileSync(filePath, 'same-size-after!');

    expect(() => registry.consume({ token: issued.token, owner }))
      .toThrow('approved upload file changed before delivery');
    expect(() => registry.consume({ token: issued.token, owner })).toThrow('SURFACE_APPROVAL_INVALID');
  });

  it('rejects symbolic links and expired approvals', () => {
    const { directory, filePath } = temporaryFile();
    const linkPath = path.join(directory, 'linked.txt');
    fs.symlinkSync(filePath, linkPath);
    expect(() => inspectBrowserUploadFile(linkPath)).toThrow('does not follow symbolic links');

    let now = 1_000;
    const registry = new RelayBrowserUploadApprovalRegistry(() => now);
    const issued = registry.issue({ owner, file: inspectBrowserUploadFile(filePath), ttlMs: 1 });
    now = 1_001;
    expect(() => registry.consume({ token: issued.token, owner })).toThrow('SURFACE_APPROVAL_INVALID');
  });

  it('does not expose an absolute path when file inspection fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-missing-'));
    temporaryDirectories.push(directory);
    const missingPath = path.join(directory, 'missing-canary.txt');
    let message = '';
    try {
      inspectBrowserUploadFile(missingPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('missing-canary.txt');
    expect(message).not.toContain(directory);
  });
});
